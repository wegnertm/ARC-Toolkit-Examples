# Export ARC Accessibility Findings

This script retrieves and filters accessibility findings via the [TPGi ARC API](https://www.tpgi.com/arc-platform/) for a specific source.

## Note on Color Contrast findings

Color contrast errors are excluded in the findings export. Color contrast presents challenges for automated testing. A single line of CSS could result in thousands of errors, which overwhelms all other topic areas of errors and could cause the spreadsheet generation to fail. Moreover, an element could have insufficient color contrast but not represent a WCAG violation due to the element not being available for user interaction (e.g. a disabled control in HTML) (Source: WCAG Understanding Docs)

## 📦 Prerequisites

- [Node.js](https://nodejs.org/) installed (version 14 or later recommended)
- An active ARC API key generate from the ARC Platform.

## 🛠 Installation

1. Clone or download this repository
1. Open a terminal and navigate to the project folder
1. Install dependencies (if any):

    ```bash
    npm install
    ```

1. Run the script using `node index.js`, providing the following arguements:

    1. A comma-seperated list of the source titles to include.
    2. The ARC API Access token for the account.

    Example:

    ```bash
    node index.js "Source One, Source Two, Source Three" <ARC API Access Token>
    ```

## File Overview

- index.js – main script for fetching and filtering findings
- data.js – set of KnowledgeCenter resources to map to each finding

## Files Generated

- Accessibility_Findings.xlsx - An Excel workbook containing the results

## 🚫 CORS Notice

This script is meant to be run in Node.js, not in a browser, due to cross-origin limitations (CORS) on the ARC API.
