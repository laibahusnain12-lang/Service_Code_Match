# Service Code Match Portal

A static, GitHub Pages-ready portal for matching South vendor services with the `Manual Services updated` reference master. It replaces repeatedly running a local Python matching script with a browser-based workflow.

## What it does

- Reads Excel workbooks in the browser.
- Lets you select the reference sheet (defaults to `Manual Services updated`).
- Saves the parsed reference rows in the current browser's IndexedDB so the master is selected only once per browser/device.
- Lets you upload each new South workbook and choose the sheet to process (defaults to `All Vendor Services`).
- Compares vendor services with the reference catalogue and adds a suggested service code/name, match percentage, review status, and existing-code comparison.
- Adds a row-level reviewer decision to the vendor sheet. The downloaded workbook preserves the source workbook's original tabs, adds client-friendly comparison columns to the selected vendor sheet, includes other possible codes for ambiguous matches, and does not add separate review or summary tabs or expose internal matching methods.
- Only a 100% exact-normalized name match with one unique code and no category or existing-code conflict is auto-approved. Ambiguous rows include a suggested code, ranked using an existing code and matching vendor categories when available, plus the other possible matches; they remain pending until reviewed. It downloads a new `.xlsx` without an `Auto - Summary` worksheet; the original `Service Code` column is not overwritten.
- Processes all workbook content locally in a Web Worker. It does not send workbook contents to a matching API/server.
- Optionally uses an Ollama model running on the same computer to rerank a capped set of uncertain catalogue candidates. The model may only select supplied catalogue entries; its selections remain suggestions requiring row-by-row verification.

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

The reference catalogue and any imported prior suggestions or approvals are retained in this browser's IndexedDB. Catalogue records keep only the service code, display name, standardized name, group, subgroup, and status.

### Each time you have a new South file

1. Under **South Workbook**, select the new South `.xlsx` file.
2. Check that **All Vendor Services** is selected (or choose the correct sheet).
3. Check the high-confidence and review thresholds if needed; defaults are 95 and 80.
4. Click **Run service matching** and keep the page open until 100% is shown.
5. Click **Download Excel**. The generated file is named `<input-name>_AUTO_MATCHED.xlsx`; the selected vendor worksheet is updated, original workbook tabs are preserved, and no additional review or summary tabs are added.
6. Check the `Reviewer Decision` column on that sheet. Exact 100% matches with one candidate code and no category or existing-code conflict are marked `Auto-Approved (100% exact)`; other rows are `Pending`. Confirm each pending row against the reference, then enter `Approved` and the verified code.
7. Select a matched workbook in **Use prior matches as suggestions** and click **Import suggestions**. Candidate suggestions and approved decisions with codes found in the saved catalogue are imported. Imported candidates remain review-required; prior approvals suggest codes for later rows but do not auto-approve them.

### Optional local AI ranking

1. Install Ollama locally and download a model, for example `ollama pull qwen2.5:7b`.
2. Configure Ollama to allow the exact portal origin in `OLLAMA_ORIGINS` (for local development, typically `http://localhost:8000`; for a published portal, use its exact HTTPS origin). Restart Ollama after changing the setting. Do not use a wildcard origin on an internet-connected machine.
3. In the portal, expand **Optional local AI ranking**, enable it, enter the installed model name, and set a limit. Start with 100 unique service names.
4. The browser sends only service terms, category context, and the candidate catalogue descriptions to Ollama at `localhost:11434`. It does not send vendor names, rates, or whole workbook rows. The model reranks only supplied candidates; it cannot create service codes.
5. If Ollama is unavailable, the regular matcher output is retained. The displayed match percentage remains the text-similarity score, not AI confidence. AI-ranked suggestions require manual verification; only safe exact 100% unique matches are auto-approved.

## Review Status

The client-facing status labels are concise: exact match, strong suggestion, suggested match, low match, multiple possible matches, category conflict, existing-code mismatch, missing service name, or no match. Internal matching methods are not included as result columns.

- Imported candidate suggestions and reviewer-approved mappings can be reused in later runs as suggestions. Imported suggestions remain review-required and are not treated as approvals.

The browser version uses a character/token shortlist before its similarity calculation to keep matching responsive on large files. Scores are intended for review prioritization, not clinical or contractual approval. Results may differ from Python RapidFuzz on fuzzy matches because the shortlist and search implementation are browser-optimized.

## Requirements / limitations

- A modern browser with Web Workers, IndexedDB, and enough available memory for the selected workbook.
- Optional local AI ranking requires Ollama, a locally downloaded model, sufficient local compute, and Ollama CORS configuration for the exact portal origin. A local model may be slower than regular matching, so enable it for a limited number of repeated uncertain names first.
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
