import fetch from 'node-fetch';
import ExcelJS from 'exceljs';
import { WCAG_REFERENCE, WCAG_TESTS } from './data.js';

// ==== Config ====
// Usage:
//   node index.js "Source A, Source B" <API_KEY>
//   node index.js "Source A" <API_KEY> --date-from=2025-01-01 --date-to=2025-01-31
//
// Without date args: exports findings from the single most recent completed scan per source.
// With date args:    exports findings from the most recent completed scan within that range.

const SOURCES = (process.argv[2] ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

if (SOURCES.length === 0) {
  console.error('❌ Please provide one or more source titles (comma-separated) as argv[2].');
  process.exit(1);
}

const API_KEY = process.argv[3] ?? '<hard-code your API key here>';

const extraArgs      = process.argv.slice(4);
const DATE_FROM      = extraArgs.find(a => a.startsWith('--date-from='))?.split('=')[1];
const DATE_TO        = extraArgs.find(a => a.startsWith('--date-to='))?.split('=')[1];
const INCLUDE_DETAIL = extraArgs.includes('--include-details');

const BASE    = 'https://arc.tpgi.com/api';
const HEADERS = { accept: 'application/json', 'api-key': API_KEY };

const CONTRAST_CRITERIA = new Set(['1.4.3', '1.4.11']);

let ruleMap = {};

function log(...args) {
  console.log('[ARC]', ...args);
}

// ==== Rules ====

async function loadRules() {
  log('Loading rules...');
  const res = await fetch(`${BASE}/v1/tests`, { headers: HEADERS });
  if (!res.ok) throw new Error(`Failed to load rules: ${res.status} ${res.statusText}`);
  const rules = await res.json();
  for (const r of rules) ruleMap[r.key] = r;
  log(`Rules loaded: ${rules.length}`);
}

// ==== Data sources ====

async function resolveSourceIds(sourceTitles) {
  log('Resolving source IDs...');
  let offset = 0;
  const allSources = [];

  while (true) {
    const res = await fetch(`${BASE}/v2/datasources?limit=500&offset=${offset}`, { headers: HEADERS });
    if (!res.ok) throw new Error(`Failed to fetch datasources: ${res.status} ${res.statusText}`);
    const page = await res.json();
    if (!Array.isArray(page) || page.length === 0) break;
    allSources.push(...page);
    if (page.length < 500) break;
    offset += page.length;
  }

  const map = new Map();
  for (const s of allSources) {
    if (sourceTitles.includes(s.title)) map.set(s.title, s.id);
  }

  for (const title of sourceTitles) {
    if (!map.has(title)) console.warn(`⚠️  Source not found: "${title}"`);
  }

  log(`Resolved ${map.size} of ${sourceTitles.length} source(s)`);
  return map;
}

// ==== Scans ====

async function getLatestScan(sourceId) {
  const url = `${BASE}/v1/scans/${sourceId}?status=success&limit=1`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) { console.warn(`⚠️  Failed to get scans for source ${sourceId}: ${res.status}`); return null; }
  const data = await res.json();
  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

async function getLatestScanInRange(sourceId, dateFrom, dateTo) {
  const from = new Date(dateFrom);
  const to   = new Date(dateTo + 'T23:59:59Z');
  let offset = 0;

  while (true) {
    const url = `${BASE}/v1/scans/${sourceId}?status=success&limit=50&offset=${offset}`;
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) { console.warn(`⚠️  Failed to get scans for source ${sourceId}: ${res.status}`); return null; }
    const scans = await res.json();
    if (!Array.isArray(scans) || scans.length === 0) break;

    for (const scan of scans) {
      const d = new Date(scan.date);
      if (d > to) continue;   // scan is newer than range end, keep looking
      if (d < from) return null; // gone past range start, nothing to find
      return scan; // first scan within range (most recent)
    }

    offset += scans.length;
  }
  return null;
}

// ==== Findings ====

async function fetchFindingsPage(scanId, offset, limit) {
  const url = `${BASE}/v1/scans/${scanId}/findings?offset=${offset}&limit=${limit}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return await res.json();
}

async function getScanFindings(scanId) {
  let offset = 0;
  const all  = [];

  while (true) {
    let data         = null;
    let limit        = 100;
    let lastErr      = null;

    // Retry with a smaller limit if the server closes the connection early
    while (limit >= 25) {
      try {
        data = await fetchFindingsPage(scanId, offset, limit);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (err.code === 'ERR_STREAM_PREMATURE_CLOSE' && limit > 25) {
          limit = Math.floor(limit / 2);
          log(`  Premature close at offset ${offset} — retrying with limit=${limit}...`);
        } else {
          break;
        }
      }
    }

    if (lastErr) {
      console.warn(`⚠️  Giving up at offset ${offset} after retries: ${lastErr.message}`);
      break;
    }

    if (!Array.isArray(data) || data.length === 0) break;
    all.push(...data);
    if (data.length < limit) break;
    offset += data.length;
  }

  return all;
}

// ==== Contrast filter ====

function isContrastFinding(finding) {
  const rule = ruleMap[finding.ruleKey];
  if (!rule) return false;
  return rule.standards?.some(s => CONTRAST_CRITERIA.has(s.criterionKey)) ?? false;
}

function normalizeUrl(raw) {
  try {
    const u = new URL(raw);
    u.hostname  = u.hostname.replace(/^www\./, '');
    u.pathname  = u.pathname.replace(/\/+$/, '') || '/';
    u.search    = '';
    u.hash      = '';
    return u.toString().toLowerCase();
  } catch {
    return raw.toLowerCase().replace(/\/+$/, '');
  }
}

function buildContrastSummaryRows(contrastBySource) {
  const counts = new Map();

  for (const [source, findings] of contrastBySource.entries()) {
    for (const f of findings) {
      const normalized = normalizeUrl(f.componentUrl);
      const key = `${source}|||${normalized}`;
      const cur = counts.get(key) ?? {
        sourceTitle:    source,
        componentTitle: f.componentTitle,
        componentUrl:   normalized,
        contrastCount:  0
      };
      cur.contrastCount++;
      counts.set(key, cur);
    }
  }

  return Array.from(counts.values()).sort((a, b) => {
    if (a.sourceTitle !== b.sourceTitle) return a.sourceTitle.localeCompare(b.sourceTitle);
    return b.contrastCount - a.contrastCount;
  });
}

// ==== Excel helpers ====

function safeSheetName(name) {
  return name.replace(/[:\\/?*[\]]/g, ' ').slice(0, 31);
}

function applyHeaderStyles(sheet) {
  sheet.getRow(1).eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '150969' } };
    cell.font = { color: { argb: 'FFFFFF' }, bold: true };
  });
}

function addRowsToSheet(sheet, rows, columns) {
  rows.forEach(row => {
    const criterion = row.ruleCriteria;
    const refKey  = Object.keys(WCAG_REFERENCE).find(k => k.startsWith(criterion));
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

    const refColIdx  = columns.findIndex(c => c.key === 'wcagReferenceLink') + 1;
    const testColIdx = columns.findIndex(c => c.key === 'wcagTestLink') + 1;
    [newRow.getCell(refColIdx), newRow.getCell(testColIdx)].forEach(cell => {
      if (cell.value && typeof cell.value === 'object' && cell.value.text) {
        cell.font = { color: { argb: '0000FF' }, underline: true };
      }
    });
  });

  const htmlColIdx = columns.findIndex(c => c.key === 'instanceHTMLSource') + 1;
  for (let i = 2; i <= sheet.rowCount; i++) {
    sheet.getRow(i).getCell(htmlColIdx).font = { name: 'Courier New', size: 10 };
  }
}

function buildFindingsSummaryRows(perSourceRowsMap) {
  const counts = new Map();

  for (const [source, rows] of perSourceRowsMap.entries()) {
    for (const r of rows) {
      const url = normalizeUrl(r.componentUrl ?? '');
      const key = `${source}|||${r.instanceEngineKey}|||${r.ruleKey}|||${url}`;
      const cur = counts.get(key) ?? {
        sourceTitle:      source,
        componentTitle:   r.componentTitle,
        componentUrl:     url,
        engine:           r.instanceEngineKey || '',
        ruleKey:          r.ruleKey,
        ruleTitle:        r.ruleTitle || '',
        ruleCriteria:     r.ruleCriteria || '',
        ruleSeverity:     r.ruleSeverity || '',
        ruleCategory:     r.ruleCategory || '',
        instances:        0,
        ruleDescription:  r.ruleDescription || '',
        ruleComplementary: r.ruleComplementary || ''
      };
      cur.instances++;
      counts.set(key, cur);
    }
  }

  return Array.from(counts.values()).sort((a, b) => {
    if (a.sourceTitle !== b.sourceTitle) return a.sourceTitle.localeCompare(b.sourceTitle);
    if (a.componentUrl !== b.componentUrl) return a.componentUrl.localeCompare(b.componentUrl);
    if (b.instances !== a.instances) return b.instances - a.instances;
    return (a.ruleKey || '').localeCompare(b.ruleKey || '');
  });
}


async function writeWorkbook(perSourceRowsMap, scanInfoMap, contrastBySource) {
  const wb = new ExcelJS.Workbook();

  // --- Scan Info sheet ---
  const infoSheet = wb.addWorksheet('Scan Info');
  infoSheet.columns = [
    { header: 'Source',              key: 'sourceName',         width: 30 },
    { header: 'Scan ID',             key: 'scanId',             width: 38 },
    { header: 'Scan Date',           key: 'date',               width: 22 },
    { header: 'Findings Count',      key: 'findingsCount',      width: 16 },
    { header: 'Components Scanned',  key: 'componentsScanned',  width: 20 }
  ];
  for (const info of scanInfoMap.values()) infoSheet.addRow(info);
  applyHeaderStyles(infoSheet);

  // --- Contrast Summary sheet ---
  const contrastSheet = wb.addWorksheet('Contrast Summary');
  contrastSheet.columns = [
    { header: 'Component',               key: 'componentTitle', width: 30 },
    { header: 'URL',                     key: 'componentUrl',   width: 50 },
    { header: 'Contrast Findings Count', key: 'contrastCount',  width: 22 }
  ];
  buildContrastSummaryRows(contrastBySource).forEach(r => contrastSheet.addRow(r));
  applyHeaderStyles(contrastSheet);

  // --- Findings Summary sheet ---
  const findingsSummarySheet = wb.addWorksheet('Findings Summary');
  findingsSummarySheet.columns = [
    { header: 'Component',      key: 'componentTitle',    width: 30 },
    { header: 'URL',            key: 'componentUrl',      width: 50 },
    { header: 'Engine',         key: 'engine',            width: 10 },
    { header: 'Rule Title',     key: 'ruleTitle',         width: 40 },
    { header: 'Severity',       key: 'ruleSeverity',      width: 12 },
    { header: 'Category',       key: 'ruleCategory',      width: 14 },
    { header: 'Instances',      key: 'instances',         width: 12 },
    { header: 'Description',    key: 'ruleDescription',   width: 40 },
    { header: 'Complementary',  key: 'ruleComplementary', width: 40 }
  ];
  const findingsSummaryRows = buildFindingsSummaryRows(perSourceRowsMap);
  findingsSummaryRows.forEach(r => findingsSummarySheet.addRow(r));

  const grandTotal = findingsSummaryRows.reduce((sum, r) => sum + r.instances, 0);
  const totalRow = findingsSummarySheet.addRow({ componentTitle: 'TOTAL', instances: grandTotal });
  totalRow.font = { bold: true };

  applyHeaderStyles(findingsSummarySheet);

  // --- Detailed Findings sheet (opt-in via --include-details) ---
  if (INCLUDE_DETAIL) {
    const columns = [
      { header: 'Component',      key: 'componentTitle',     width: 25 },
      { header: 'URL',            key: 'componentUrl',       width: 30 },
      { header: 'Engine',         key: 'instanceEngineKey',  width: 10 },
      { header: 'Severity',       key: 'ruleSeverity',       width: 10 },
      { header: 'Category',       key: 'ruleCategory',       width: 14 },
      { header: 'Rule',           key: 'ruleTitle',          width: 25 },
      { header: 'Description',    key: 'ruleDescription',    width: 40 },
      { header: 'Complementary',  key: 'ruleComplementary',  width: 40 },
      { header: 'HTML Source Code', key: 'instanceHTMLSource', width: 40 }
    ];

    const allDetailRows = SOURCES.flatMap(src => perSourceRowsMap.get(src) ?? []);
    const detailSheet = wb.addWorksheet('Detailed Findings');
    detailSheet.columns = columns;

    allDetailRows.forEach(row => detailSheet.addRow(row));

    const htmlColIdx = columns.findIndex(c => c.key === 'instanceHTMLSource') + 1;
    for (let i = 2; i <= detailSheet.rowCount; i++) {
      detailSheet.getRow(i).getCell(htmlColIdx).font = { name: 'Courier New', size: 10 };
    }

    applyHeaderStyles(detailSheet);
  }

  const filename = SOURCES.length === 1
    ? `${SOURCES[0]} - Accessibility_Findings.xlsx`
    : 'Multiple Sources - Accessibility_Findings.xlsx';

  await wb.xlsx.writeFile(filename);
  log(`✅ Written: "${filename}"`);
}

// ==== Main ====

async function run() {
  try {
    if (DATE_FROM || DATE_TO) {
      log(`Date range: ${DATE_FROM ?? 'start'} → ${DATE_TO ?? 'today'}`);
    } else {
      log('Mode: most recent completed scan per source');
    }

    await loadRules();

    const sourceIdMap = await resolveSourceIds(SOURCES);

    const perSourceRowsMap = new Map();
    const scanInfoMap      = new Map();
    const contrastBySource = new Map();
    for (const src of SOURCES) {
      perSourceRowsMap.set(src, []);
      contrastBySource.set(src, []);
    }

    for (const source of SOURCES) {
      const sourceId = sourceIdMap.get(source);
      if (!sourceId) {
        log(`Skipping "${source}" — source ID not resolved`);
        continue;
      }

      log(`Getting scan for "${source}"...`);
      const scan = DATE_FROM || DATE_TO
        ? await getLatestScanInRange(sourceId, DATE_FROM ?? '1970-01-01', DATE_TO ?? new Date().toISOString().slice(0, 10))
        : await getLatestScan(sourceId);

      if (!scan) {
        log(`No completed scan found for "${source}"${DATE_FROM || DATE_TO ? ' in the specified date range' : ''}`);
        continue;
      }

      log(`Scan ${scan.scanId} — date: ${scan.date}, findings: ${scan.findingsCount}`);
      scanInfoMap.set(source, {
        sourceName:        scan.sourceName ?? source,
        scanId:            scan.scanId,
        date:              scan.date,
        findingsCount:     scan.findingsCount,
        componentsScanned: scan.componentsScanned
      });

      log(`Fetching findings...`);
      const findings = await getScanFindings(scan.scanId);
      log(`  Raw: ${findings.length}`);

      const filtered  = findings.filter(f => !isContrastFinding(f));
      const contrast  = findings.filter(f =>  isContrastFinding(f));
      log(`  After contrast exclusion: ${filtered.length} (${contrast.length} contrast findings summarized separately)`);

      contrastBySource.get(source).push(...contrast);

      for (const f of filtered) {
        const rule = ruleMap[f.ruleKey] ?? {};
        perSourceRowsMap.get(source).push({
          sourceTitle:        source,
          componentTitle:     f.componentTitle,
          componentUrl:       normalizeUrl(f.componentUrl ?? ''),
          instanceEngineKey:  f.engineKey,
          jobDate:            f.jobDate,
          instanceLocator:    f.instanceLocator,
          instanceLocatorType:f.instanceLocatorType,
          instanceHTMLSource: f.instanceHTMLSource,
          ruleKey:            f.ruleKey,
          ruleCriteria:       rule.standards?.[0]?.criterionKey ?? '--',
          ruleTitle:          f.ruleTitle || rule.title || '',
          ruleSeverity:       f.severity  || rule.severity || '',
          ruleCategory:       f.category  || rule.type?.title || '',
          ruleDescription:    rule.description   || '',
          ruleComplementary:  rule.complementary || ''
        });
      }
    }

    await writeWorkbook(perSourceRowsMap, scanInfoMap, contrastBySource);

  } catch (err) {
    console.error('❌ Error:', err);
    process.exit(1);
  }
}

run();
