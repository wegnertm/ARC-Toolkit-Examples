# Latest Scan Export

Exports accessibility findings from the most recent ARC automated scan per source into an Excel workbook. Unlike the period-based `automated-scan-export`, this script targets a specific scan run, making it significantly faster.

## How it works

1. Resolves each source title to its data source ID via the ARC API.
2. Fetches the most recent completed scan for that source.
3. Retrieves all findings for that scan (paginated).
4. Excludes color contrast findings (WCAG 1.4.3 / 1.4.11) — see note below.
5. Enriches findings with WCAG criterion, description, and complementary guidance from the rules API.
6. Writes an Excel workbook with a **Scan Info** sheet, a **Summary** sheet, and a per-source **Findings** sheet.

## Note on Color Contrast findings

Color contrast errors are excluded. A single CSS change could produce thousands of contrast errors that overwhelm all other finding categories and can cause spreadsheet generation to fail. Additionally, a contrast error does not always represent a WCAG violation (e.g., a disabled control is exempt). See WCAG Understanding Docs for details.

## Prerequisites

- [Node.js](https://nodejs.org/) v14 or later
- An active ARC API key generated from the ARC Platform

## Installation

```bash
cd latest-scan-export
npm install
```

## Usage

### Most recent scan (default)

```bash
node index.js "Source One, Source Two" <ARC_API_KEY>
```

Fetches the single most recently completed scan for each source and exports its findings.

### Specific date range

```bash
node index.js "Source One" <ARC_API_KEY> --date-from=2025-01-01 --date-to=2025-01-31
```

Fetches the most recently completed scan within the given date range for each source.

| Argument | Required | Description |
|---|---|---|
| `argv[2]` | Yes | Comma-separated list of source titles |
| `argv[3]` | Yes | ARC API access token |
| `--date-from` | No | Earliest scan date to consider (`YYYY-MM-DD`) |
| `--date-to` | No | Latest scan date to consider (`YYYY-MM-DD`) |

## Output

A single Excel file is written to the current directory:

- `<Source Name> - Accessibility_Findings.xlsx` — single source
- `Multiple Sources - Accessibility_Findings.xlsx` — multiple sources

### Sheets

| Sheet | Contents |
|---|---|
| **Scan Info** | Scan ID, date, findings count, and components scanned for each source |
| **Summary** | Finding counts grouped by Source × Engine × Rule, sorted by instance count |
| **\<Source\> - Findings** | Full per-instance detail including locator, HTML snippet, WCAG links |

## File overview

| File | Purpose |
|---|---|
| `index.js` | Main script — API calls, filtering, Excel generation |
| `data.js` | WCAG Knowledge Center URL mappings for guideline and test procedure links |
