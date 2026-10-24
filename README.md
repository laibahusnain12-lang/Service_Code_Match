# Service Code Match Portal

A static, GitHub Pages-ready portal for matching South vendor services with the `Manual Services updated` reference master. It replaces repeatedly running a local Python matching script with a browser-based workflow.

## What it does

- Reads Excel workbooks in the browser.
- Lets you select the reference sheet (defaults to `Manual Services updated`).
- Saves the parsed reference rows in the current browser's IndexedDB so the master is selected only once per browser/device.
- Lets you upload each new South workbook and choose the sheet to process (defaults to `All Vendor Services`).
- Checks exact normalized names first, then searches fuzzy candidates.
- Adds separate `Auto Candidate ...` columns, match score, method, status, alternatives, and comparison to the existing South code.
- Adds candidate code, match percentage, status, alternatives, and existing-code comparison columns to the vendor sheet, plus separate ready and review worksheets. It downloads a new `.xlsx` without an `Auto - Summary` worksheet; the original `Service Code` column is not overwritten.
- Processes all workbook content locally in a Web Worker. It does not send workbook contents to a matching API/server.

## Important privacy note

**Do not upload vendor workbooks or the reference master into the GitHub repository.** GitHub Pages websites are publicly accessible. This repository contains only the portal code. The selected reference master is stored in the browser that imported it, not in the repository or on a matching server.

The saved master is available only in the same browser profile on the same device. If you use a different browser/device, import the master once on that browser too. Use **Clear** in the portal to remove the saved master from that browser.

## Publish on GitHub Pages

1. Download and extract `service-code-match-portal.zip`.
2. Create a new GitHub repository, for example `service-code-match-portal`.
3. Upload the *contents* of the extracted folder to the repository root: `index.html`, `styles.css`, `app.js`, `matcher-worker.js`, `.nojekyll`, and this README. Do not upload any workbook.
4. In the repository, open **Settings → Pages**.
5. Under **Build and deployment**, select **Deploy from a branch**.
6. Select branch **main** and folder **/(root)**, then click **Save**.
7. Open the published URL displayed on the Pages settings screen. GitHub Pages may need several minutes to publish after the first setup.

Official guide: <https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site>

## How to use the portal

### First use (one time per browser)

1. Open the published portal in a modern Chrome or Edge browser.
2. Under **Reference Master**, select the workbook containing `Manual Services updated`.
3. Check that the reference sheet dropdown says `Manual Services updated`.
4. Click **Load and save reference master** and wait for the green **Ready** indicator.

Only the needed reference columns are retained in this browser's IndexedDB: service code, display name, standardized name, group, subgroup, and status.

### Each time you have a new South file

1. Under **South Workbook**, select the new South `.xlsx` file.
2. Check that **All Vendor Services** is selected (or choose the correct sheet).
3. Check the high-confidence and review thresholds if needed; defaults are 95 and 80.
4. Click **Run service matching** and keep the page open until 100% is shown.
5. Click **Download Excel**. The generated file is named `<input-name>_AUTO_MATCHED.xlsx` and contains the comparison results, ready rows, and review-needed rows.
6. Review `Auto Match Status / Review Required` and `Auto Candidate Alternatives` before approving any candidate code.

## Match interpretation

- **EXACT MATCH** means the normalized source name matched a reference display/standardized name; it is still a candidate and should be verified.
- **HIGH-CONFIDENCE FUZZY CANDIDATE** means the text similarity meets the high threshold but is not an exact match.
- **FUZZY CANDIDATE** / **LOW CONFIDENCE** requires manual review.
- **AMBIGUOUS** means the matching reference name points to multiple service codes or top candidates tie across codes; the candidate code is left blank to avoid guessing.
- **BLANK SERVICE NAME** requires manual entry.

The browser version uses a character/token shortlist before its similarity calculation to keep matching responsive on large files. Scores are intended for review prioritization, not clinical or contractual approval. Results may differ from Python RapidFuzz on fuzzy matches because the shortlist and search implementation are browser-optimized.

## Requirements / limitations

- A modern browser with Web Workers, IndexedDB, and enough available memory for the selected workbook.
- Internet access is needed to load the SheetJS Excel reader from its official CDN. The workbook contents remain in the browser; the library file is downloaded as a script.
- GitHub Pages is static hosting; no Python, database, or API server is needed.
- The downloaded workbook's data and sheets are retained, but SheetJS Community Edition may not preserve every advanced Excel style, macro, external connection, or embedded object. Use an original copy for critical formatted or macro-enabled workbooks.
- Do not use this as final service-code approval. Validate ambiguous and low-confidence suggestions against the reference owner.

## Optional smoke test

If Node.js is installed, the included worker smoke test can be run from the extracted portal folder with `node tests/worker-smoke-test.js`. It checks exact matching, fuzzy candidate assignment, existing-code comparison, ambiguous-code protection, and blank-name handling.

## Files

- `index.html` — user interface
- `styles.css` — responsive styling
- `app.js` — file selection, local master storage, workbook reading and export
- `matcher-worker.js` — background matching algorithm
- `.nojekyll` — serves the static application files directly

## Library attribution

Excel workbook import/export uses SheetJS Community Edition via the official SheetJS CDN: <https://docs.sheetjs.com/docs/getting-started/installation/standalone/> (Apache-2.0; see the SheetJS project for license details).
