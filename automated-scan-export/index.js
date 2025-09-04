import fetch from 'node-fetch';
import ExcelJS from 'exceljs';
import { WCAG_REFERENCE, WCAG_TESTS } from './data.js';

// ==== Config ====
// Pass sources as a comma-separated string in argv[2], e.g.:
// node index.js "Source A, Source B" "API_KEY"
const SOURCES = (process.argv[2] ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

if (SOURCES.length === 0) {
  console.error('❌ Please provide one or more source titles (comma-separated) as argv[2].');
  process.exit(1);
}

const API_KEY = process.argv[3] ?? "<hard-code your API key here>";
const RULES_URL = 'https://arc.tpgi.com/api/v1/tests';
const RESULTS_URL = 'https://arc.tpgi.com/api/v1/test-results';
const PERIOD = 'period-type=Q';

let ruleMap = {};
let allRules = [];
let automatedRules;

function log(...args) {
  console.log('[ARC]', ...args);
}

async function getAllRules() {
  log("Get all rules");
  const response = await fetch(RULES_URL, {
    headers: { accept: 'application/json', 'api-key': API_KEY }
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch rules: ${response.status} ${response.statusText}`);
  }

  allRules = await response.json();
  log('All rules:', allRules.length);

  // Exclude 1.4.3 / 1.4.11 from automated rules
  automatedRules = allRules.filter(el =>
    el.ruleSet?.key === "AUTOMATED" &&
    el.standards?.[0]?.criterionKey !== "1.4.3" &&
    el.standards?.[0]?.criterionKey !== "1.4.11"
  );

  log('Automated rules (no contrast):', automatedRules.length);
  automatedRules.forEach(rule => {
    ruleMap[rule.key] = rule;
  });
}

async function getTestsReportedInPeriod() {
  log("Get all Test Results");
  let offset = 0;
  let allTestsReportedForPeriod = [];

  while (true) {
    const url = `${RESULTS_URL}?offset=${offset}&${PERIOD}`;
    const response = await fetch(url, {
      headers: { accept: 'application/json', 'api-key': API_KEY }
    });

    if (!response.ok) {
      console.warn(`⚠️ Failed to fetch test results page at offset ${offset}: ${response.status}`);
      break;
    }

    const data = await response.json();
    if (!Array.isArray(data) || data.length <= 1) break;

    allTestsReportedForPeriod = allTestsReportedForPeriod.concat(data);
    offset += data.length; // next page
  }

  log("Tests Reported for Period:", allTestsReportedForPeriod.length);
  return allTestsReportedForPeriod;
}

function extractTestKeys(data) {
  return data.map(item => item.testKey);
}

function filterToSources(data, sourcesSet) {
  return data.filter(item => sourcesSet.has(item.sourceTitle));
}

async function getFindingsForTestKey(testKey, sourcesSet) {
  const engineKey = testKey.slice(0, 3);
  const ruleKey = testKey.slice(5);
  let offset = 0;
  let findingsForTestKey = [];

  while (true) {
    const url = `${RESULTS_URL}/${ruleKey}/instances?offset=${offset}&engine-key=${engineKey}&${PERIOD}`;
    log(url);
    const response = await fetch(url, {
      headers: { accept: 'application/json', 'api-key': API_KEY }
    });

    if (!response.ok) {
      console.warn(`⚠️ Failed to fetch ${testKey}: ${response.status}`);
      return findingsForTestKey;
    }

    const data = await response.json();
    if (!Array.isArray(data) || data.length <= 1) break;

    findingsForTestKey = findingsForTestKey.concat(filterToSources(data, sourcesSet));
    offset += data.length; // next page
  }

  log(`Findings for ${testKey}:`, findingsForTestKey.length);
  return findingsForTestKey;
}

function safeSheetName(name) {
  // Excel sheet name rules: <= 31 chars, cannot contain: : \ / ? * [ ]
  const invalid = /[:\\/?*\[\]]/g;
  const cleaned = name.replace(invalid, ' ');
  return cleaned.length <= 31 ? cleaned : cleaned.slice(0, 31);
}

function applyHeaderStyles(sheet) {
  const headerRow = sheet.getRow(1);
  headerRow.eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '150969' } };
    cell.font = { color: { argb: 'FFFFFF' }, bold: true };
  });
}

function addRowsToSheet(sheet, rows, columns) {
  rows.forEach(row => {
    const criterion = row.ruleCriteria;
    const refKey = Object.keys(WCAG_REFERENCE).find(k => k.startsWith(criterion));
    const testKey = Object.keys(WCAG_TESTS).find(k => k.startsWith(criterion));

    const newRow = sheet.addRow({
      ...row,
      wcagReferenceLink: refKey && WCAG_REFERENCE[refKey]
        ? { text: refKey, hyperlink: `https://arc.tpgi.com${WCAG_REFERENCE[refKey]}` }
        : '',
      wcagTestLink: testKey && WCAG_TESTS[testKey]
        ? { text: testKey, hyperlink: `https://arc.tpgi.com${WCAG_TESTS[testKey]}` }
        : ''
    });

    // Style hyperlinks
    const refColIndex = columns.findIndex(col => col.key === 'wcagReferenceLink') + 1;
    const testColIndex = columns.findIndex(col => col.key === 'wcagTestLink') + 1;

    [newRow.getCell(refColIndex), newRow.getCell(testColIndex)].forEach(cell => {
      const v = cell.value;
      const hasText = v && typeof v === 'object' && 'text' in v && v.text;
      if (hasText) {
        cell.font = { color: { argb: '0000FF' }, underline: true };
      }
    });
  });

  // Monospace for HTML Source column
  const htmlColumnIndex = columns.findIndex(col => col.key === 'instanceHTMLSource') + 1;
  for (let i = 2; i <= sheet.rowCount; i++) {
    const cell = sheet.getRow(i).getCell(htmlColumnIndex);
    cell.font = { name: 'Courier New', size: 10 };
  }
}

// === SUMMARY (now includes Engine) ===
function buildSummaryRows(perSourceRowsMap) {
  // Aggregate per (Source × Engine × RuleKey)
  // key: `${source}|||${engine}|||${ruleKey}`
  const counts = new Map();

  for (const [source, rows] of perSourceRowsMap.entries()) {
    for (const r of rows) {
      const engine = r.instanceEngineKey || '';
      const key = `${source}|||${engine}|||${r.ruleKey}`;
      const current = counts.get(key) || {
        sourceTitle: source,
        engine: engine,                // NEW
        ruleKey: r.ruleKey,
        ruleTitle: r.ruleTitle || '',
        ruleCriteria: r.ruleCriteria || '',
        ruleSeverity: r.ruleSeverity || '',
        instances: 0
      };
      current.instances += 1;
      counts.set(key, current);
    }
  }

  // Sort by Source, then Engine, then Instances desc, then Rule Key
  const result = Array.from(counts.values()).sort((a, b) => {
    if (a.sourceTitle !== b.sourceTitle) return a.sourceTitle.localeCompare(b.sourceTitle);
    if ((a.engine || '') !== (b.engine || '')) return (a.engine || '').localeCompare(b.engine || '');
    if (b.instances !== a.instances) return b.instances - a.instances;
    return (a.ruleKey || '').localeCompare(b.ruleKey || '');
  });

  return result;
}

async function writeWorkbookWithSummary(perSourceRowsMap) {
  const workbook = new ExcelJS.Workbook();

  // --- Summary sheet first (includes Engine) ---
  const summaryColumns = [
    { header: 'Source', key: 'sourceTitle', width: 24 },
    { header: 'Engine', key: 'engine', width: 10 },                // NEW
    { header: 'Rule Key', key: 'ruleKey', width: 18 },
    { header: 'Rule Title', key: 'ruleTitle', width: 40 },
    { header: 'WCAG Success Criterion', key: 'ruleCriteria', width: 20 },
    { header: 'Severity', key: 'ruleSeverity', width: 12 },
    { header: 'Instances', key: 'instances', width: 12 }
  ];
  const summaryRows = buildSummaryRows(perSourceRowsMap);
  const summarySheet = workbook.addWorksheet('Summary');
  summarySheet.columns = summaryColumns;
  summaryRows.forEach(r => summarySheet.addRow(r));
  applyHeaderStyles(summarySheet);

  // --- Per-source detail sheets ---
  const columns = [
    { header: 'Source', key: 'sourceTitle', width: 20 },
    { header: 'Component', key: 'componentTitle', width: 25 },
    { header: 'URL', key: 'componentUrl', width: 30 },
    { header: 'Engine', key: 'instanceEngineKey', width: 10 },
    { header: 'Finding Date', key: 'jobDate', width: 15 },
    { header: 'Locator', key: 'instanceLocator', width: 30 },
    { header: 'HTML Source Code', key: 'instanceHTMLSource', width: 40 },
    { header: 'Severity', key: 'ruleSeverity', width: 10 },
    { header: 'Category', key: 'ruleCategory', width: 14 },
    { header: 'WCAG Success Criterion', key: 'ruleCriteria', width: 25 },
    { header: 'Guideline Summary (ARC Seat Required)', key: 'wcagReferenceLink', width: 40 },
    { header: 'Manual Testing Procedure (ARC Seat Required)', key: 'wcagTestLink', width: 40 },
    { header: 'Rule', key: 'ruleTitle', width: 25 },
    { header: 'Description', key: 'ruleDescription', width: 40 },
    { header: 'Complementary', key: 'ruleComplementary', width: 40 }
  ];

  for (const source of SOURCES) {
    const rows = perSourceRowsMap.get(source) ?? [];
    const sheetName = safeSheetName(`${source} - Findings`);
    const sheet = workbook.addWorksheet(sheetName);
    sheet.columns = columns;

    addRowsToSheet(sheet, rows, columns);
    applyHeaderStyles(sheet);
  }

  const filename = (SOURCES.length === 1)
    ? `${SOURCES[0]} - Accessibility_Findings.xlsx`
    : `Multiple Sources - Accessibility_Findings.xlsx`;

  await workbook.xlsx.writeFile(filename);
  log(`✅ Excel file "${filename}" written with Summary (incl. Engine) + per-source worksheets.`);
}

async function run() {
  try {
    await getAllRules();

    const sourcesSet = new Set(SOURCES);

    const automatedFindingsNoContrast = (await getTestsReportedInPeriod()).filter(el =>
      el.method === "Automated" &&
      el.topic !== "Contrast" // ensure this matches API (singular "topic")
    );

    const testKeys = extractTestKeys(automatedFindingsNoContrast);
    log('Test keys:', testKeys.length);

    // Prepare grouped rows (per source)
    const perSourceRowsMap = new Map();
    for (const src of SOURCES) perSourceRowsMap.set(src, []);

    for (const testKey of testKeys) {
      const findings = await getFindingsForTestKey(testKey, sourcesSet);
      if (findings.length === 0) continue;

      const ruleKey = testKey.slice(5);
      const matchingRule = ruleMap[ruleKey];

      findings.forEach(finding => {
        const row = {
          sourceTitle: finding.sourceTitle,
          componentTitle: finding.componentTitle,
          componentUrl: finding.componentUrl,
          instanceEngineKey: finding.instanceEngineKey || testKey.slice(0, 3), // used in summary
          jobDate: finding.jobDate,
          instanceHTMLSource: finding.instanceHTMLSource,
          instanceLocator: finding.instanceLocator,
          ruleKey, // include for accurate grouping
          ruleCriteria: matchingRule?.standards?.[0]?.criterionKey || '--',
          ruleTitle: matchingRule?.title || '',
          ruleSeverity: matchingRule?.severity || '',
          ruleCategory: matchingRule?.type?.title || '',
          ruleDescription: matchingRule?.description || '',
          ruleComplementary: matchingRule?.complementary || ''
        };
        if (!perSourceRowsMap.has(row.sourceTitle)) {
          perSourceRowsMap.set(row.sourceTitle, []);
        }
        perSourceRowsMap.get(row.sourceTitle).push(row);
      });
    }

    await writeWorkbookWithSummary(perSourceRowsMap);

  } catch (error) {
    console.error('❌ Script error:', error);
  }
}

run();
