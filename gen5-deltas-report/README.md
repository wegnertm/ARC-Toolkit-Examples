# Introduction

This project is used to create a report of certain deltas betweeen 2 Automated scans. The output shows each domain for which data is being requested.

## Creating the delta report

1. Lookup the Account and Subscription codes for your account in ARC.
1. Determine what day of the month you want to your report to begin. Typically this is the first day of the previous month.
1. Run the script

    ```sh
    node index.js <Start date, YYYY-MM-DD> <ARC Account Code> <ARC Subscription Code>
    ```

1. The script will create the following files:

    - Deltas.csv
    - Full Data.csv
    - MMM YYYY Delta Report.xlsx (where MMM YYYY is the month and year the report is for)

1. Open `Deltas.csv` and copy the rows starting with line 2 to the Deltas worksheet in the XLSX file [^1].
1. Open `Full Data.csv` and copy the rows starting with line 2 to the Full Data worksheet in the XLSX file [^1].

[^1]: When pasting the values from the CSV into the worksheet, perform the following steps:

    1. Place the focus in cell A2
    1. Paste the CSV file
    1. In Excel, go to the Data tab and click the Text to Columns button.
    1. On Step 1, select "Delimineted" and click Next
    1. On Step 2, select "Comma" and click Finish (there is no need to go to step 3)
