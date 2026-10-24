/* Service Code Match Portal. All workbook processing runs in this browser. */
(() => {
  'use strict';

  const DB_NAME = 'service-code-match-portal';
  const DB_VERSION = 1;
  const STORE_NAME = 'settings';
  const MASTER_KEY = 'reference-master-v1';
  const DEFAULT_MASTER_SHEET = 'Manual Services updated';
  const DEFAULT_SOURCE_SHEET = 'All Vendor Services';
  const READY_SHEET_NAME = 'Auto - Ready';
  const REVIEW_SHEET_NAME = 'Auto - Review Needed';
  const REVIEW_TOKENS = ['AMBIGUOUS', 'LOW CONFIDENCE', 'FUZZY CANDIDATE', 'MEDICAL TERM VARIANT', 'HISTORICAL MAPPING', 'UNMATCHED', 'BLANK SERVICE NAME', 'CATEGORY CONFLICT', 'EXISTING CODE DISAGREEMENT'];
  const READY_TOKENS = ['EXACT MATCH', 'HIGH-CONFIDENCE FUZZY CANDIDATE'];
  const OUTPUT_COLUMNS = [
    'Auto Candidate Service Code',
    'Auto Candidate Standardized Service Name',
    'Auto Candidate Service Display Name',
    'Auto Candidate Group',
    'Auto Candidate Sub Group',
    'Auto Match Score',
    'Auto Match Method',
    'Auto Match Status / Review Required',
    'Auto Candidate Alternatives',
    'Auto Existing Code Check'
  ];

  const $ = (id) => document.getElementById(id);
  let dbPromise;
  let savedMaster = null;
  let sourceWorkbook = null;
  let sourceFileName = '';
  let sourceSheetName = '';
  let latestOutputWorkbook = null;
  let latestOutputName = '';
  let activeWorker = null;
  let masterWorkbookPending = null;
  let masterFileNamePending = '';
  let progressHintTimer = null;

  function isBlank(value) { return value == null || String(value).trim() === ''; }
  function text(value) { return isBlank(value) ? '' : String(value).trim(); }
  function normalize(value) {
    if (isBlank(value)) return '';
    return String(value).normalize('NFKC').toLocaleLowerCase().trim()
      .replace(/&/g, ' and ')
      .replace(/[’'`´]/g, '')
      .replace(/[^\p{L}\p{N}_\s]+/gu, ' ')
      .replace(/[_\s]+/g, ' ').trim();
  }
  function headerKey(value) { return normalize(value); }
  function chooseColumn(headers, names, required = true) {
    const map = new Map();
    headers.forEach((value, index) => {
      if (!isBlank(value)) map.set(headerKey(value), index);
    });
    for (const name of names) {
      const key = headerKey(name);
      if (map.has(key)) return map.get(key);
    }
    if (required) throw new Error(`Required column not found. Tried: ${names.join(', ')}. Available columns: ${headers.filter(v => !isBlank(v)).join(', ')}`);
    return null;
  }
  function getCell(row, col) { return col == null || col < 0 ? '' : text(row[col]); }
  function setMessage(element, message, kind = '') {
    element.textContent = message || '';
    element.className = 'inline-message' + (kind ? ` ${kind}` : '');
  }
  function toast(message) {
    const node = $('toast');
    node.textContent = message;
    node.classList.add('visible');
    window.clearTimeout(toast._timer);
    toast._timer = window.setTimeout(() => node.classList.remove('visible'), 3500);
  }
  function formatNumber(value) { return Number(value || 0).toLocaleString(); }
  function copyCellStyle(targetCell, sourceCell) {
    if (!targetCell || !sourceCell || !sourceCell.s) return;
    targetCell.s = JSON.parse(JSON.stringify(sourceCell.s));
  }
  function pickHeaderStyleTemplate(sheet) {
    const rowIndex = 0;
    const limit = 50;
    for (let col = 0; col < limit; col++) {
      const cell = sheet[XLSX.utils.encode_cell({ r: rowIndex, c: col })];
      if (cell && cell.s) return cell;
    }
    return null;
  }

  function openDatabase() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) { reject(new Error('This browser does not support local reference storage. Please use a recent version of Chrome or Edge.')); return; }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open local browser storage.'));
      request.onblocked = () => reject(new Error('Browser storage is blocked by another tab. Close duplicate portal tabs and refresh.'));
    });
    return dbPromise;
  }
  async function dbGet(key) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readonly');
      const request = transaction.objectStore(STORE_NAME).get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error('Could not read local browser storage.'));
    });
  }
  async function dbPut(key, value) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put(value, key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('Could not save reference master in this browser.'));
      transaction.onabort = () => reject(transaction.error || new Error('Saving the reference master was cancelled.'));
    });
  }
  async function dbDelete(key) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).delete(key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('Could not clear saved reference master.'));
    });
  }

  async function readExcelFile(file) {
    if (!window.XLSX) throw new Error('The Excel reader did not load. Check your internet connection and refresh this page.');
    const buffer = await file.arrayBuffer();
    return XLSX.read(buffer, { type: 'array', cellDates: true, cellNF: false, cellStyles: true });
  }
  function rowsForSheet(workbook, sheetName) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) throw new Error(`Sheet '${sheetName}' is not present in this workbook.`);
    return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false, blankrows: true });
  }

  function referenceRecordsFromSheet(workbook, sheetName) {
    const matrix = rowsForSheet(workbook, sheetName);
    if (!matrix.length) throw new Error('The selected reference sheet is empty.');
    const headers = matrix[0] || [];
    const codeCol = chooseColumn(headers, ['Ser. Code', 'Service Code', 'Standardized Service Code']);
    const displayCol = chooseColumn(headers, ['Service Display Name', 'Matched Display Name', 'Service Name']);
    const standardCol = chooseColumn(headers, ['Standarized Service Name', 'Standardized Service Name', 'Standardised Service Name'], false);
    const groupCol = chooseColumn(headers, ['Group', 'Standard Group'], false);
    const subgroupCol = chooseColumn(headers, ['Sub Group', 'Subgroup', 'Standard Sub Group'], false);
    const statusCol = chooseColumn(headers, ['status', 'Status'], false);
    const records = [];
    for (let rowIndex = 1; rowIndex < matrix.length; rowIndex++) {
      const row = matrix[rowIndex] || [];
      const code = getCell(row, codeCol);
      if (!code) continue;
      const status = getCell(row, statusCol);
      const words = normalize(status).split(' ');
      if (['inactive', 'disabled', 'retired', 'discontinued', 'deleted'].some(word => words.includes(word))) continue;
      const display = getCell(row, displayCol);
      const standard = getCell(row, standardCol);
      if (!display && !standard) continue;
      records.push({
        code,
        display,
        standard,
        group: getCell(row, groupCol),
        subgroup: getCell(row, subgroupCol),
        status
      });
    }
    if (!records.length) throw new Error('No usable service names and codes found in the selected reference sheet.');
    return records;
  }

  function historicalMappingsFromWorkbook(workbook) {
    for (const sheetName of workbook.SheetNames) {
      const matrix = rowsForSheet(workbook, sheetName);
      const headers = matrix[0] || [];
      const statusCol = chooseColumn(headers, ['Matching Status'], false);
      const sourceNameCol = chooseColumn(headers, ['Service Name', 'Vendor Service Name'], false);
      const codeCol = chooseColumn(headers, ['Standardized Service Code', 'Service Code', 'Ser. Code'], false);
      if (statusCol == null || sourceNameCol == null || codeCol == null) continue;

      const displayCol = chooseColumn(headers, ['Matched Display Name', 'Service Display Name'], false);
      const standardCol = chooseColumn(headers, ['Standardized Service Name', 'Standarized Service Name'], false);
      const groupCol = chooseColumn(headers, ['Standard Group (Reference)', 'Group'], false);
      const subgroupCol = chooseColumn(headers, ['Standard Sub Group (Reference)', 'Sub Group'], false);
      const candidatesByName = new Map();
      for (const row of matrix.slice(1)) {
        if (normalize(getCell(row, statusCol)) !== 'match') continue;
        const name = getCell(row, sourceNameCol);
        const code = getCell(row, codeCol);
        const key = normalize(name);
        if (!key || !code) continue;
        if (!candidatesByName.has(key)) candidatesByName.set(key, new Map());
        const byCode = candidatesByName.get(key);
        if (!byCode.has(code)) {
          byCode.set(code, {
            code,
            display: getCell(row, displayCol),
            standard: getCell(row, standardCol),
            group: getCell(row, groupCol),
            subgroup: getCell(row, subgroupCol),
            status: 'Historical automated match; review required',
            sourceName: name
          });
        }
      }
      return [...candidatesByName.values()]
        .filter(byCode => byCode.size === 1)
        .map(byCode => [...byCode.values()][0]);
    }
    return [];
  }

  function sourceRowsFromSheet(workbook, sheetName) {
    const matrix = rowsForSheet(workbook, sheetName);
    if (!matrix.length) throw new Error('The selected South worksheet is empty.');
    const headers = matrix[0] || [];
    const serviceCol = chooseColumn(headers, ['Service Name', 'Service Display Name', 'Vendor Service Name']);
    const standardCol = chooseColumn(headers, ['Standardized Service Name', 'Standarized Service Name', 'Standardised Service Name'], false);
    const existingCodeCol = chooseColumn(headers, ['Service Code', 'Standardized Service Code', 'Ser. Code'], false);
    const rows = matrix.slice(1).map((row, index) => ({
      sourceRowNumber: index + 2,
      rawName: getCell(row || [], serviceCol),
      standardizedName: getCell(row || [], standardCol),
      existingCode: getCell(row || [], existingCodeCol)
    }));
    return { rows, matrix, headers };
  }

  function setChip(chip, label, ready) {
    chip.textContent = label;
    chip.className = 'status-chip' + (ready ? ' status-ready' : ' status-muted');
  }
  function updateRunState() { $('run-btn').disabled = !(savedMaster && sourceWorkbook && sourceSheetName && window.XLSX); }

  async function refreshSavedMaster() {
    try {
      const cached = await dbGet(MASTER_KEY);
      if (cached && Array.isArray(cached.records) && cached.records.length) {
        savedMaster = cached;
        showMasterReady(cached);
      } else {
        savedMaster = null;
        $('saved-master').hidden = true;
        setChip($('master-chip'), 'Not set up', false);
      }
    } catch (error) {
      setMessage($('master-message'), error.message, 'error');
    }
    updateRunState();
  }
  function showMasterReady(master) {
    $('saved-master').hidden = false;
    $('saved-master-title').textContent = 'Reference master is ready';
    const historyInfo = master.historicalMappings && master.historicalMappings.length
      ? ` · ${master.historicalMappings.length.toLocaleString()} prior suggestions (review required)`
      : '';
    $('saved-master-details').textContent = `${master.records.length.toLocaleString()} usable reference records${historyInfo} · ${master.sheetName || DEFAULT_MASTER_SHEET} · saved in this browser`;
    setChip($('master-chip'), 'Ready', true);
    setMessage($('master-message'), 'Ready. You do not need to select the reference workbook again in this browser unless the master changes.', 'success');
  }

  $('master-file').addEventListener('change', async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    masterWorkbookPending = null;
    masterFileNamePending = file.name;
    $('master-file-name').textContent = file.name;
    $('save-master-btn').disabled = true;
    $('master-sheet-row').hidden = true;
    setMessage($('master-message'), 'Reading reference workbook locally…');
    try {
      const workbook = await readExcelFile(file);
      masterWorkbookPending = workbook;
      $('master-sheet').innerHTML = '';
      workbook.SheetNames.forEach(name => {
        const option = document.createElement('option'); option.value = name; option.textContent = name;
        if (name === DEFAULT_MASTER_SHEET) option.selected = true;
        $('master-sheet').appendChild(option);
      });
      $('master-sheet-row').hidden = false;
      $('save-master-btn').disabled = false;
      setMessage($('master-message'), `Workbook read. Choose the reference sheet and save it. ${workbook.SheetNames.length} sheet(s) found.`);
    } catch (error) {
      setMessage($('master-message'), error.message, 'error');
      toast('Could not read reference workbook');
    }
  });

  $('save-master-btn').addEventListener('click', async () => {
    if (!masterWorkbookPending) return;
    const sheetName = $('master-sheet').value;
    $('save-master-btn').disabled = true;
    setMessage($('master-message'), 'Extracting the service code master and saving it locally…');
    try {
      const records = referenceRecordsFromSheet(masterWorkbookPending, sheetName);
      const referenceCodes = new Set(records.map(record => record.code));
      const historicalMappings = historicalMappingsFromWorkbook(masterWorkbookPending)
        .filter(mapping => referenceCodes.has(mapping.code));
      const master = { records, historicalMappings, fileName: masterFileNamePending, sheetName, savedAt: new Date().toISOString(), version: 2 };
      await dbPut(MASTER_KEY, master);
      savedMaster = master;
      showMasterReady(master);
      masterWorkbookPending = null;
      $('master-file').value = '';
      $('master-file-name').textContent = 'Reference stored in this browser';
      toast(`Saved ${formatNumber(records.length)} reference records`);
    } catch (error) {
      setMessage($('master-message'), error.message, 'error');
    } finally {
      $('save-master-btn').disabled = !masterWorkbookPending;
      updateRunState();
    }
  });

  $('clear-master-btn').addEventListener('click', async () => {
    if (!window.confirm('Clear the saved reference master from this browser? You will need to select the reference workbook again before matching.')) return;
    try {
      await dbDelete(MASTER_KEY);
      savedMaster = null;
      $('saved-master').hidden = true;
      setChip($('master-chip'), 'Not set up', false);
      setMessage($('master-message'), 'Saved reference removed from this browser.');
      updateRunState();
      toast('Saved reference master cleared');
    } catch (error) { setMessage($('master-message'), error.message, 'error'); }
  });

  $('south-file').addEventListener('change', async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    sourceWorkbook = null; sourceFileName = file.name; sourceSheetName = '';
    latestOutputWorkbook = null;
    $('south-file-name').textContent = file.name;
    $('results-panel').hidden = true;
    setChip($('source-chip'), 'Reading file…', false);
    setMessage($('source-message'), 'Reading South workbook locally…');
    try {
      sourceWorkbook = await readExcelFile(file);
      $('south-sheet').innerHTML = '';
      sourceWorkbook.SheetNames.forEach(name => {
        const option = document.createElement('option'); option.value = name; option.textContent = name;
        if (name === DEFAULT_SOURCE_SHEET) option.selected = true;
        $('south-sheet').appendChild(option);
      });
      $('south-sheet-row').hidden = false;
      sourceSheetName = $('south-sheet').value;
      // Validate that the default/current sheet has a recognizable service-name header.
      sourceRowsFromSheet(sourceWorkbook, sourceSheetName);
      setChip($('source-chip'), 'File loaded', true);
      setMessage($('source-message'), `${file.name} is ready. ${sourceWorkbook.SheetNames.length} worksheet(s) found.`, 'success');
    } catch (error) {
      sourceWorkbook = null;
      setChip($('source-chip'), 'Needs attention', false);
      setMessage($('source-message'), error.message, 'error');
    }
    updateRunState();
  });

  $('south-sheet').addEventListener('change', () => {
    if (!sourceWorkbook) return;
    sourceSheetName = $('south-sheet').value;
    try {
      const result = sourceRowsFromSheet(sourceWorkbook, sourceSheetName);
      setMessage($('source-message'), `${sourceSheetName} selected · ${formatNumber(result.rows.length)} data row(s) detected.`, 'success');
      setChip($('source-chip'), 'File loaded', true);
    } catch (error) {
      setMessage($('source-message'), error.message, 'error');
      setChip($('source-chip'), 'Needs attention', false);
    }
    updateRunState();
  });

  function setupDropZone(dropId, inputId) {
    const drop = $(dropId); const input = $(inputId);
    ['dragenter', 'dragover'].forEach(name => drop.addEventListener(name, (event) => { event.preventDefault(); drop.classList.add('drag-over'); }));
    ['dragleave', 'drop'].forEach(name => drop.addEventListener(name, (event) => { event.preventDefault(); drop.classList.remove('drag-over'); }));
    drop.addEventListener('drop', (event) => {
      const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      if (!file) return;
      const transfer = new DataTransfer(); transfer.items.add(file); input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }
  setupDropZone('master-drop', 'master-file');
  setupDropZone('south-drop', 'south-file');

  function showProgress(title, detail, percent) {
    $('progress-panel').hidden = false;
    $('progress-title').textContent = title;
    $('progress-detail').textContent = detail;
    $('progress-number').textContent = `${Math.round(percent)}%`;
    $('progress-fill').style.width = `${Math.min(100, Math.max(0, percent))}%`;
  }
  function clearProgressHint() {
    if (progressHintTimer) {
      window.clearTimeout(progressHintTimer);
      progressHintTimer = null;
    }
  }
  function scheduleProgressHint() {
    clearProgressHint();
    progressHintTimer = window.setTimeout(() => {
      if ($('progress-number') && Number($('progress-number').textContent.replace(/[^\d.]/g, '')) <= 1) {
        showProgress('Still indexing reference data…', 'This large workbook is being prepared for matching. Please keep this tab open.', 1);
      }
    }, 5000);
  }
  function buildFilteredSheet(workbook, rows, sheetName, predicate) {
    const data = [OUTPUT_COLUMNS.slice()];
    for (const row of rows || []) {
      if (!predicate(row)) continue;
      data.push(OUTPUT_COLUMNS.map(header => row[header] == null ? '' : row[header]));
    }
    if (data.length === 1) {
      if (workbook.Sheets[sheetName]) {
        delete workbook.Sheets[sheetName];
        workbook.SheetNames = workbook.SheetNames.filter(name => name !== sheetName);
      }
      return workbook;
    }
    const filteredSheet = XLSX.utils.aoa_to_sheet(data);
    if (workbook.Sheets[sheetName]) {
      delete workbook.Sheets[sheetName];
      workbook.SheetNames = workbook.SheetNames.filter(name => name !== sheetName);
    }
    XLSX.utils.book_append_sheet(workbook, filteredSheet, sheetName);
    return workbook;
  }

  function buildReadySheet(workbook, rows) {
    return buildFilteredSheet(workbook, rows, READY_SHEET_NAME, row => {
      const status = String(row['Auto Match Status / Review Required'] || '').toUpperCase();
      return READY_TOKENS.some(token => status.includes(token)) && !status.includes('CATEGORY CONFLICT') && !status.includes('EXISTING CODE DISAGREEMENT');
    });
  }

  function buildReviewSheet(workbook, rows) {
    return buildFilteredSheet(workbook, rows, REVIEW_SHEET_NAME, row => {
      const status = String(row['Auto Match Status / Review Required'] || '').toUpperCase();
      if (status.includes('HIGH-CONFIDENCE FUZZY CANDIDATE')) return false;
      return REVIEW_TOKENS.some(token => status.includes(token));
    });
  }

  function buildOutputWorkbook(workbook, sheetName, outputRows, sourceMatrix) {
    const ws = workbook.Sheets[sheetName];
    const headers = (sourceMatrix[0] || []).slice();
    const headerMap = new Map();
    headers.forEach((h, i) => { if (!isBlank(h)) headerMap.set(headerKey(h), i); });
    const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
    let nextCol = range.e.c + 1;
    const outCols = {};
    const headerStyleTemplate = pickHeaderStyleTemplate(ws) || { s: { font: { bold: true } } };
    OUTPUT_COLUMNS.forEach(header => {
      const key = headerKey(header);
      if (headerMap.has(key)) outCols[header] = headerMap.get(key);
      else { outCols[header] = nextCol; headerMap.set(key, nextCol); nextCol++; }
    });
    OUTPUT_COLUMNS.forEach(header => {
      const cellAddress = XLSX.utils.encode_cell({ r: 0, c: outCols[header] });
      const cell = { t: 's', v: header };
      copyCellStyle(cell, headerStyleTemplate);
      ws[cellAddress] = cell;
    });
    outputRows.forEach((row, index) => {
      const excelRow = index + 1;
      OUTPUT_COLUMNS.forEach(header => {
        const value = row[header] == null ? '' : row[header];
        const cellAddress = XLSX.utils.encode_cell({ r: excelRow, c: outCols[header] });
        if (header === 'Auto Match Score') {
          ws[cellAddress] = { t: 'n', v: Number(value) || 0 };
        } else {
          ws[cellAddress] = { t: 's', v: String(value) };
        }
      });
    });
    range.e.c = Math.max(range.e.c, nextCol - 1);
    range.e.r = Math.max(range.e.r, outputRows.length);
    ws['!ref'] = XLSX.utils.encode_range(range);

    // Preserve the original worksheet formatting and layout; remove any summary tab from an older output.
    if (workbook.Sheets['Auto - Summary']) {
      delete workbook.Sheets['Auto - Summary'];
      workbook.SheetNames = workbook.SheetNames.filter(name => name !== 'Auto - Summary');
    }
    buildReadySheet(workbook, outputRows);
    buildReviewSheet(workbook, outputRows);
    return workbook;
  }

  $('run-btn').addEventListener('click', async () => {
    if (!savedMaster || !sourceWorkbook) return;
    if (!window.XLSX) { setMessage($('source-message'), 'Excel library did not load. Refresh with an internet connection.', 'error'); return; }
    let sourceData;
    const high = Number($('high-threshold').value);
    const review = Number($('review-threshold').value);
    if (!(review >= 0 && high >= review && high <= 100)) {
      setMessage($('source-message'), 'Thresholds must satisfy 0 ≤ review threshold ≤ high-confidence threshold ≤ 100.', 'error'); return;
    }
    try { sourceData = sourceRowsFromSheet(sourceWorkbook, sourceSheetName); }
    catch (error) { setMessage($('source-message'), error.message, 'error'); return; }
    const activeWorkbook = sourceWorkbook;
    const sourceRows = sourceData.rows;
    if (!sourceRows.length) { setMessage($('source-message'), 'No data rows were found beneath the header row.', 'error'); return; }

    $('run-btn').disabled = true;
    $('results-panel').hidden = true;
    showProgress('Preparing your workbook…', 'Getting your files ready', 1);
    scheduleProgressHint();
    setMessage($('source-message'), 'Your workbook is being processed in this browser.');
    if (activeWorker) { activeWorker.terminate(); activeWorker = null; }
    try {
      activeWorker = new Worker('./matcher-worker.js');
    } catch (error) {
      $('run-btn').disabled = false;
      showProgress('Could not start processing', 'Refresh the portal and try again. If the issue continues, contact your support team.', 0);
      setMessage($('source-message'), 'The workbook could not be processed. Refresh the portal and try again.', 'error');
      return;
    }
    activeWorker.onmessage = (event) => {
      const message = event.data || {};
      clearProgressHint();
      if (message.type === 'stage') showProgress(message.title || 'Matching…', message.detail || '', message.percent || 1);
      if (message.type === 'progress') showProgress('Preparing your results…', `${formatNumber(message.completed)} of ${formatNumber(message.total)} rows processed`, message.percent);
      if (message.type === 'error') {
        showProgress('Matching stopped', message.error || 'An unexpected matching error occurred.', 0);
        setMessage($('source-message'), message.error || 'An unexpected error occurred.', 'error');
        $('run-btn').disabled = false;
        activeWorker.terminate(); activeWorker = null;
      }
      if (message.type === 'done') {
        try {
          showProgress('Writing Excel output…', 'Adding candidate columns and summary worksheet', 96);
          const stats = message.stats;
          const rows = message.results;
          latestOutputWorkbook = buildOutputWorkbook(activeWorkbook, sourceSheetName, rows, sourceData.matrix);
          latestOutputName = `${sourceFileName.replace(/\.(xlsx|xlsm|xlsb|xls)$/i, '')}_AUTO_MATCHED.xlsx`;
          const assigned = rows.filter(row => !isBlank(row['Auto Candidate Service Code'])).length;
          const flaggedTokens = ['AMBIGUOUS', 'LOW CONFIDENCE', 'FUZZY CANDIDATE', 'MEDICAL TERM VARIANT', 'HISTORICAL MAPPING', 'UNMATCHED', 'BLANK SERVICE NAME', 'CATEGORY CONFLICT', 'EXISTING CODE DISAGREEMENT'];
          const flagged = rows.filter(row => flaggedTokens.some(token => String(row['Auto Match Status / Review Required'] || '').toUpperCase().includes(token))).length;
          $('metric-total').textContent = formatNumber(rows.length);
          $('metric-assigned').textContent = formatNumber(assigned);
          $('metric-review').textContent = formatNumber(flagged);
          $('status-breakdown').innerHTML = '';
          Object.entries(stats.counts).sort((a,b) => b[1]-a[1] || a[0].localeCompare(b[0])).forEach(([status, count]) => {
            const tr = document.createElement('tr');
            const tdStatus = document.createElement('td'); tdStatus.textContent = status;
            const tdCount = document.createElement('td'); tdCount.className = 'numeric'; tdCount.textContent = formatNumber(count);
            tr.append(tdStatus, tdCount); $('status-breakdown').appendChild(tr);
          });
          $('results-caption').textContent = `${latestOutputName} · Original service-code values were not overwritten.`;
          $('results-panel').hidden = false;
          showProgress('Matching completed', 'Output is ready. Click Download Excel to save it to your computer.', 100);
          setMessage($('source-message'), `Completed: ${formatNumber(rows.length)} rows processed. Download the output below.`, 'success');
          $('download-btn').disabled = false;
          $('results-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
          toast(`Matching complete · ${formatNumber(assigned)} candidate codes`);
        } catch (error) {
          showProgress('Could not write output', error.message, 0);
          setMessage($('source-message'), error.message, 'error');
        } finally {
          clearProgressHint();
          $('run-btn').disabled = false;
          if (activeWorker) { activeWorker.terminate(); activeWorker = null; }
        }
      }
    };
    activeWorker.onerror = (event) => {
      clearProgressHint();
      showProgress('Matching stopped', event.message || 'The browser worker failed.', 0);
      setMessage($('source-message'), event.message || 'The browser worker failed.', 'error');
      $('run-btn').disabled = false;
      if (activeWorker) { activeWorker.terminate(); activeWorker = null; }
    };
    activeWorker.postMessage({
      type: 'MATCH',
      masterRecords: savedMaster.records,
      historicalMappings: savedMaster.historicalMappings || [],
      sourceRows,
      thresholds: { high, review }
    });
  });

  $('download-btn').addEventListener('click', () => {
    if (!latestOutputWorkbook) return;
    try {
      XLSX.writeFile(latestOutputWorkbook, latestOutputName, { compression: true });
      toast('Excel output download started');
    } catch (error) { toast(`Download failed: ${error.message}`); }
  });

  async function boot() {
    if (!window.XLSX) setMessage($('master-message'), 'Excel reader could not load from the SheetJS CDN. Check your internet connection and refresh.', 'error');
    await refreshSavedMaster();
  }
  boot().catch(error => setMessage($('master-message'), error.message, 'error'));
})();
