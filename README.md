# Catalogue Match Portal

A static, browser-based tool for matching records in a spreadsheet against a reference catalogue. It runs entirely on the client, so no backend, database, or API server is required.

## Features

- Reads Excel workbooks (`.xlsx`) directly in the browser
- Stores the reference catalogue locally in the browser (IndexedDB), so it only needs to be imported once per browser
- Matches input records against the catalogue and returns a suggested code, suggested name, and match score
- Flags each row with a review status and a reviewer decision column
- Exports a new workbook with original sheets preserved, plus a client-ready Client Report sheet and a full Technical Details sheet
- Processes all data locally in a Web Worker; workbook contents are never sent to a server
- Optional local AI re-ranking of uncertain matches via [Ollama](https://ollama.com)

## Privacy

All processing happens in your browser. Workbooks and the reference catalogue are not uploaded anywhere.

> **Do not commit workbooks or reference data to this repository.** GitHub Pages sites are publicly accessible. The repository should contain application code only.

The saved catalogue is tied to the browser profile and device that imported it. Use **Clear** in the portal to remove it.

## Getting Started

### Deploy with GitHub Pages

1. Create a new GitHub repository.
2. Upload the project files to the repository root:
   `index.html`, `styles.css`, `app.js`, `matcher-worker.js`, `.nojekyll`, `README.md`
3. Go to **Settings → Pages**.
4. Under **Build and deployment**, choose **Deploy from a branch**, select `main` and `/(root)`, then save.
5. Open the published URL once deployment completes.

See the [GitHub Pages documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site) for details.

### Run locally

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

## Usage

### 1. Load the reference catalogue (once per browser)

1. Select the workbook containing the reference catalogue.
2. Choose the reference sheet.
3. Click **Load and save reference master** and wait for the **Ready** indicator.

### 2. Run a match

1. Select the workbook to process and choose the sheet.
2. Adjust the confidence and review thresholds if needed (defaults: 95 and 80).
3. Click **Run matching** and wait until progress reaches 100%.
4. Click **Download Excel** to export the results.

### 3. Review results

Each row includes a suggested code, match score, review status, and a reviewer decision column. Only exact, unambiguous matches are auto-approved. All other rows are marked `Pending` and should be verified against the reference before approval.

Previously reviewed workbooks can be imported as suggestions for future runs. Imported suggestions are never auto-approved.

## Review Statuses

| Status | Meaning |
|---|---|
| Exact match | Normalized names match exactly with a single unique code |
| Strong suggestion | High similarity score |
| Suggested match | Moderate similarity score |
| Low match | Weak similarity; manual review required |
| Multiple possible matches | More than one plausible code |
| Category conflict | Match conflicts with the record's category |
| Existing-code mismatch | Suggested code differs from the code already present |
| Missing name | No service name to match |
| No match | No suitable candidate found |

## Optional: Local AI Ranking

1. Install Ollama and pull a model, for example `ollama pull qwen2.5:7b`.
2. Add the portal's exact origin to `OLLAMA_ORIGINS` and restart Ollama. Avoid wildcard origins on internet-connected machines.
3. In the portal, enable **Local AI ranking**, enter the model name, and set a processing limit.

Only service terms, category context, and candidate descriptions are sent to the local Ollama instance. The model can only choose from supplied candidates and cannot generate new codes. If Ollama is unavailable, standard matching results are used.

## Limitations

- Requires a modern browser with Web Workers and IndexedDB support.
- Large workbooks depend on available browser memory.
- The SheetJS library is loaded from its CDN, so an internet connection is required on first load.
- Exported workbooks may not preserve macros, external connections, embedded objects, or some advanced formatting. Keep the original file for critical workbooks.
- Match scores support review prioritization and are not a substitute for approval. Validate uncertain results with the catalogue owner.

## Project Structure

```
index.html          User interface
styles.css          Styling
app.js              File handling, local storage, import/export
matcher-worker.js   Background matching logic
.nojekyll           Serves static files directly
```

## Testing

With Node.js installed:

```bash
node tests/worker-smoke-test.js
```

## Acknowledgements

Excel import and export use [SheetJS Community Edition](https://docs.sheetjs.com/) (Apache-2.0).
