/* Service Code Match Portal. All workbook processing runs in this browser. */
(() => {
  'use strict';

  const DB_NAME = 'service-code-match-portal';
  const DB_VERSION = 1;
  const STORE_NAME = 'settings';
  const MASTER_KEY = 'reference-master-v1';
  const DEFAULT_MASTER_SHEET = 'Manual Services updated';
  const DEFAULT_SOURCE_SHEET = 'All Vendor Services';
  const OUTPUT_COLUMNS = [
    'Auto Candidate Service Code',
    'Auto Candidate Service Display Name',
    'Auto Candidate Group',
    'Auto Candidate Sub Group',
    'Auto Match Score',
    'Auto Match Status / Review Required',
    'Auto Candidate Alternatives',
    'Auto Existing Code Check',
    'Reviewer Decision',
    'Approved Service Code',
    'Review Notes',
    'Original Service Name'
  ];
  const OUTPUT_HEADERS = {
    'Auto Candidate Service Code': 'Suggested Code to Select',
    'Auto Candidate Service Display Name': 'Suggested Service Name',
    'Auto Candidate Group': 'Suggested Group',
    'Auto Candidate Sub Group': 'Suggested Sub Group',
    'Auto Match Score': 'Match Percentage',
    'Auto Match Status / Review Required': 'Review Status',
    'Auto Candidate Alternatives': 'Other Possible Matches',
    'Auto Existing Code Check': 'Existing Code Comparison',
    'Reviewer Decision': 'Reviewer Decision',
    'Approved Service Code': 'Approved Service Code',
    'Review Notes': 'Review Notes',
    'Original Service Name': 'Original Service Name'
  };
  const CLIENT_RESULT_COLUMNS = [
  'Original Service Name',
  'Auto Candidate Service Code',
  'Auto Candidate Service Display Name',
  'Auto Match Score',
  'Auto Match Status / Review Required'
];
const SOURCE_RESULT_COLUMNS = [
  'Auto Candidate Service Code',
  'Auto Candidate Service Display Name',
  'Auto Match Score',
  'Auto Match Status / Review Required'
];
const OUTPUT_KEYS_BY_HEADER = Object.fromEntries(Object.entries(OUTPUT_HEADERS).map(([key, header]) => [header, key]));

  function clientReviewStatus(status) {
    const upper = String(status || '').toUpperCase();
    if (upper.includes('AUTO-APPROVED (100%')) return 'Approved — exact unique match';
    if (upper.includes('EXISTING CODE DISAGREEMENT') || upper.includes('CHECK —')) return 'Existing code differs — review';
    if (upper.includes('AMBIGUOUS')) return 'Multiple possible matches — review';
    if (upper.includes('CATEGORY CONFLICT')) return 'Category conflict — review';
    if (upper.includes('BLANK SERVICE NAME')) return 'Service name missing';
    if (upper.includes('UNMATCHED')) return 'No matching service found';
    if (upper.includes('LOW CONFIDENCE')) return 'Low match — review';
    if (upper.includes('EXACT MATCH')) return 'Exact match — verify';
    if (upper.includes('HIGH-CONFIDENCE FUZZY CANDIDATE')) return 'Strong suggestion — verify';
    if (upper.includes('HISTORICAL MAPPING') || upper.includes('REVIEWER MAPPING') || upper.includes('MEDICAL TERM VARIANT') || upper.includes('LOCAL AI SUGGESTION') || upper.includes('FUZZY CANDIDATE')) return 'Suggested match — verify';
    return 'Review required';
  }
  function recommendedAction(row) {
    const status = String((row && row['Auto Match Status / Review Required']) || '').toUpperCase();
    const candidate = row ? row['Auto Candidate Service Code'] : '';
    const check = String((row && row['Auto Existing Code Check']) || '').toUpperCase();
    if (isBlank(candidate)) return 'No reliable match found - manual catalogue lookup required';
    if (status.includes('AUTO-APPROVED')) return 'No action needed; code auto-approved';
    if (status.includes('EXISTING CODE DISAGREEMENT') || check.startsWith('CHECK')) return 'Compare existing code with suggested code before approving';
    if (status.includes('AMBIGUOUS')) return 'Choose the correct code from the possible matches';
    if (status.includes('CATEGORY CONFLICT')) return 'Confirm category before approving';
    if (status.includes('LOW CONFIDENCE')) return 'Manual review required';
    if (status.includes('BLANK SERVICE NAME')) return 'Add a service name, then re-run matching';
    if (status.includes('EXACT MATCH')) return 'Verify and approve';
    if (status.includes('HIGH-CONFIDENCE')) return 'Verify and approve';
    if (status.includes('LOCAL AI')) return 'Verify the AI-ranked suggestion';
    if (status.includes('REVIEWER MAPPING')) return 'Confirm the prior reviewer mapping';
    if (status.includes('HISTORICAL')) return 'Confirm the prior match';
    if (status.includes('MEDICAL TERM')) return 'Verify the medical-term variant';
    return 'Review and approve';
  }
  function reviewStatusFill(status) {
    const value = String(status || '').toLowerCase();
    if (value.startsWith('approved')) return 'C6EFCE';
    if (value.includes('exact') || value.includes('strong')) return 'DDEBF7';
    if (value.includes('low') || value.includes('no matching') || value.includes('missing') || value.includes('no reliable')) return 'FCE4D6';
    if (value.includes('multiple') || value.includes('conflict') || value.includes('differs')) return 'F8CBAD';
    if (value.includes('unresolved') || value.includes('unmatched')) return 'F2DCDB';
    return 'FFF2CC';
  }
  function compactWorksheetColumns(sheet, removedColumns) {
    if (!removedColumns.size) return;
    const removed = [...removedColumns].sort((a, b) => a - b);
    const oldCells = Object.keys(sheet).filter(address => !address.startsWith('!'));
    const shiftedCells = new Map();
    for (const address of oldCells) {
      const cell = XLSX.utils.decode_cell(address);
      if (removedColumns.has(cell.c)) continue;
      const shift = removed.filter(column => column < cell.c).length;
      shiftedCells.set(XLSX.utils.encode_cell({ r: cell.r, c: cell.c - shift }), sheet[address]);
    }
    oldCells.forEach(address => delete sheet[address]);
    shiftedCells.forEach((cell, address) => { sheet[address] = cell; });

    if (sheet['!ref']) {
      const range = XLSX.utils.decode_range(sheet['!ref']);
      const removedBeforeEnd = removed.filter(column => column <= range.e.c).length;
      range.e.c = Math.max(range.s.c, range.e.c - removedBeforeEnd);
      sheet['!ref'] = XLSX.utils.encode_range(range);
    }
    if (Array.isArray(sheet['!cols'])) {
      sheet['!cols'] = sheet['!cols'].filter((_, index) => !removedColumns.has(index));
    }
  }

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
  function sanitizeExcelText(value) {
    const raw = value == null ? '' : String(value);
    // Remove characters that are invalid in OOXML worksheet text.
    const cleaned = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '');
    return cleaned.length > 32767 ? cleaned.slice(0, 32767) : cleaned;
  }
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
    const displayCol = chooseColumn(headers, ['Service Display Name', 'Matched Display Name', 'Service Name'], false);
    const standardCol = chooseColumn(headers, ['Standarized Service Name', 'Standardized Service Name', 'Standardised Service Name']);
    const groupCol = chooseColumn(headers, ['Group', 'Standard Group'], false);
    const subgroupCol = chooseColumn(headers, ['Sub Group', 'Subgroup', 'Standard Sub Group'], false);
    const statusCol = chooseColumn(headers, ['status', 'Status'], false);
    const codeSystemCol = chooseColumn(headers, ['Code System', 'Coding System', 'Code System Name'], false);
    const codeSystemVersionCol = chooseColumn(headers, ['Code System Version', 'Version', 'Release'], false);
    const vendorCol = chooseColumn(headers, ['Vendor', 'Provider', 'Vendor Name', 'Provider Name', 'Supplier', 'Standard Vendor', 'Standard Provider', 'Service Vendor', 'Service Provider'], false);
    const chargesCol = chooseColumn(headers, ['Charges', 'Price', 'Rate', 'Cost', 'Fee', 'Amount', 'Standard Charges', 'Standard Price', 'Service Charges', 'Service Price', 'Charge'], false);
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
        status,
         codeSystem: getCell(row, codeSystemCol),
         codeSystemVersion: getCell(row, codeSystemVersionCol),
         vendor: getCell(row, vendorCol),
         charges: getCell(row, chargesCol)
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
      const vendorCol = chooseColumn(headers, ['Standard Service Vendor / Provider', 'Vendor', 'Provider', 'Vendor Name', 'Provider Name', 'Standard Vendor', 'Standard Provider'], false);
      const chargesCol = chooseColumn(headers, ['Standard Service Charges / Price', 'Charges', 'Price', 'Rate', 'Cost', 'Fee', 'Amount', 'Charge'], false);
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
            vendor: getCell(row, vendorCol),
            charges: getCell(row, chargesCol),
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

  function approvedMappingsFromWorkbook(workbook) {
    const mappings = [];
    for (const sheetName of workbook.SheetNames) {
      const matrix = rowsForSheet(workbook, sheetName);
      const headers = matrix[0] || [];
      const decisionCol = chooseColumn(headers, ['Reviewer Decision'], false);
      const nameCol = chooseColumn(headers, ['Service Name'], false);
      const codeCol = chooseColumn(headers, ['Approved Service Code'], false);
      if (decisionCol == null || nameCol == null || codeCol == null) continue;
      const groupCol = chooseColumn(headers, ['Vendor Group'], false);
      const subgroupCol = chooseColumn(headers, ['Vendor Sub Group'], false);
      const standardVendorCol = chooseColumn(headers, ['Standard Service Vendor / Provider', 'Standard Vendor', 'Vendor', 'Provider'], false);
      const standardChargesCol = chooseColumn(headers, ['Standard Service Charges / Price', 'Charges', 'Price', 'Rate', 'Cost', 'Fee', 'Amount'], false);
      for (const row of matrix.slice(1)) {
        if (normalize(getCell(row, decisionCol)) !== 'approved') continue;
        const sourceName = getCell(row, nameCol);
        const code = getCell(row, codeCol);
        if (!sourceName || !code) continue;
        mappings.push({
          sourceName,
          code,
          group: getCell(row, groupCol),
          subgroup: getCell(row, subgroupCol),
          vendor: getCell(row, standardVendorCol),
          charges: getCell(row, standardChargesCol)
        });
      }
    }
    return mappings;
  }

  function suggestionMappingsFromWorkbook(workbook) {
    const mappings = [];
    for (const sheetName of workbook.SheetNames) {
      const matrix = rowsForSheet(workbook, sheetName);
      const headers = matrix[0] || [];
      const nameCol = chooseColumn(headers, ['Service Name', 'Vendor Service Name'], false);
      const codeCol = chooseColumn(headers, ['Auto Candidate Service Code', 'Suggested Code to Select', 'Suggested Service Code'], false);
      if (nameCol == null || codeCol == null) continue;

      const displayCol = chooseColumn(headers, ['Auto Candidate Service Display Name', 'Suggested Service Name', 'Matched Display Name'], false);
      const standardCol = chooseColumn(headers, ['Auto Candidate Standardized Service Name', 'Auto Candidate Service Name', 'Standardized Service Name'], false);
      const groupCol = chooseColumn(headers, ['Auto Candidate Group', 'Suggested Group'], false);
      const subgroupCol = chooseColumn(headers, ['Auto Candidate Sub Group', 'Suggested Sub Group'], false);
      const vendorCol = chooseColumn(headers, ['Standard Service Vendor / Provider', 'Suggested Standard Service Vendor / Provider', 'Vendor', 'Provider'], false);
      const chargesCol = chooseColumn(headers, ['Standard Service Charges / Price', 'Suggested Standard Service Charges / Price', 'Charges', 'Price', 'Rate', 'Cost', 'Fee', 'Amount'], false);
      for (const row of matrix.slice(1)) {
        const sourceName = getCell(row, nameCol);
        const code = getCell(row, codeCol);
        if (!sourceName || !code) continue;
        mappings.push({
          sourceName,
          code,
          display: getCell(row, displayCol),
          standard: getCell(row, standardCol),
          group: getCell(row, groupCol),
          subgroup: getCell(row, subgroupCol),
          vendor: getCell(row, vendorCol),
          charges: getCell(row, chargesCol),
          status: 'Imported workbook suggestion; review required'
        });
      }
    }
    return mappings;
  }

  function mergeHistoricalMappings(...mappingLists) {
    const merged = new Map();
    for (const mapping of mappingLists.flat()) {
      const key = [normalize(mapping.sourceName), normalize(mapping.group), normalize(mapping.subgroup), String(mapping.code || '').trim().toUpperCase()].join('\u241f');
      if (mapping.sourceName && mapping.code) merged.set(key, mapping);
    }
    return [...merged.values()];
  }

  function mergeApprovedMappings(...mappingLists) {
    const merged = new Map();
    for (const mapping of mappingLists.flat()) {
      const key = [normalize(mapping.sourceName), normalize(mapping.group), normalize(mapping.subgroup), String(mapping.code || '').trim().toUpperCase()].join('\u241f');
      if (mapping.sourceName && mapping.code) merged.set(key, mapping);
    }
    return [...merged.values()];
  }

  function sourceRowsFromSheet(workbook, sheetName) {
    const matrix = rowsForSheet(workbook, sheetName);
    if (!matrix.length) throw new Error('The selected worksheet is empty.');
    const headers = matrix[0] || [];
    const serviceCol = chooseColumn(headers, ['Service Name', 'Service Display Name', 'Vendor Service Name']);
    const standardCol = chooseColumn(headers, ['Standardized Service Name', 'Standarized Service Name', 'Standardised Service Name'], false);
    const existingCodeCol = chooseColumn(headers, ['Service Code', 'Standardized Service Code', 'Ser. Code'], false);
    const groupCol = chooseColumn(headers, ['Group', 'Vendor Group'], false);
    const subgroupCol = chooseColumn(headers, ['Sub Group', 'Subgroup', 'Vendor Sub Group'], false);
    const vendorCol = chooseColumn(headers, ['Vendor Name', 'Provider Name'], false);
    const chargesCol = chooseColumn(headers, ['Vendor Charges', 'Charges', 'Price', 'Rate', 'Cost', 'Fee', 'Amount', 'Charge'], false);
    const rows = matrix.slice(1).map((row, index) => ({
      sourceRowNumber: index + 2,
      rawName: getCell(row || [], serviceCol),
      standardizedName: getCell(row || [], standardCol),
      existingCode: getCell(row || [], existingCodeCol),
      sourceGroup: getCell(row || [], groupCol),
      sourceSubgroup: getCell(row || [], subgroupCol),
      vendorName: getCell(row || [], vendorCol),
      sourceCharges: getCell(row || [], chargesCol)
    }));
    return { rows, matrix, headers, groupCol, subgroupCol, vendorCol, chargesCol };
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
    const approvedInfo = master.approvedMappings && master.approvedMappings.length
      ? ` · ${master.approvedMappings.length.toLocaleString()} reviewed decisions`
      : '';
    $('saved-master-details').textContent = `${master.records.length.toLocaleString()} usable reference records${approvedInfo}${historyInfo} · ${master.sheetName || DEFAULT_MASTER_SHEET} · saved in this browser`;
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
      const approvedMappings = mergeApprovedMappings(
        savedMaster?.approvedMappings || [],
        approvedMappingsFromWorkbook(masterWorkbookPending)
      ).filter(mapping => referenceCodes.has(mapping.code));
      const master = { records, historicalMappings, approvedMappings, fileName: masterFileNamePending, sheetName, savedAt: new Date().toISOString(), version: 3 };
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

  $('approved-file').addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    $('approved-file-name').textContent = file ? file.name : 'No file selected';
    $('import-approved-btn').disabled = !file || !savedMaster;
    setMessage($('approved-message'), file ? 'Matched workbook selected. Import its candidate suggestions and any approved decisions into this browser.' : '');
  });

  $('import-approved-btn').addEventListener('click', async () => {
    const file = $('approved-file').files && $('approved-file').files[0];
    if (!file || !savedMaster) return;
    $('import-approved-btn').disabled = true;
    setMessage($('approved-message'), 'Reading matching suggestions and approved decisions…');
    try {
      const workbook = await readExcelFile(file);
      const validCodes = new Set(savedMaster.records.map(record => record.code));
      const importedSuggestions = suggestionMappingsFromWorkbook(workbook).filter(mapping => validCodes.has(mapping.code));
      const importedApprovals = approvedMappingsFromWorkbook(workbook).filter(mapping => validCodes.has(mapping.code));
      savedMaster = {
        ...savedMaster,
        historicalMappings: mergeHistoricalMappings(savedMaster.historicalMappings || [], importedSuggestions),
        approvedMappings: mergeApprovedMappings(savedMaster.approvedMappings || [], importedApprovals),
        decisionsUpdatedAt: new Date().toISOString()
      };
      await dbPut(MASTER_KEY, savedMaster);
      showMasterReady(savedMaster);
      setMessage($('approved-message'), `${importedSuggestions.length.toLocaleString()} candidate suggestions and ${importedApprovals.length.toLocaleString()} approved decisions imported. Codes not present in the current catalogue were skipped; suggestions still require review.`, 'success');
      $('approved-file').value = '';
      $('approved-file-name').textContent = 'No file selected';
    } catch (error) {
      setMessage($('approved-message'), error.message || 'Could not import workbook suggestions.', 'error');
    } finally {
      $('import-approved-btn').disabled = true;
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
    setMessage($('source-message'), 'Reading workbook locally…');
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
  function buildOutputWorkbook(workbook, sheetName, outputRows, sourceMatrix, sourceRows) {
    const ws = workbook.Sheets[sheetName];
    const obsoleteHeaders = new Set([
      'Auto Candidate Standardized Service Name',
      'Auto Match Method',
      'AI Recommendation'
    ].map(headerKey));
    const originalHeaders = (sourceMatrix[0] || []).slice();
    const removedColumns = new Set();
    originalHeaders.forEach((header, index) => {
      if (obsoleteHeaders.has(headerKey(header))) removedColumns.add(index);
    });
    compactWorksheetColumns(ws, removedColumns);
    sourceMatrix = sourceMatrix.map(row => (row || []).filter((_, index) => !removedColumns.has(index)));
    const headers = (sourceMatrix[0] || []).slice();
    const headerMap = new Map();
    headers.forEach((h, i) => { if (!isBlank(h)) headerMap.set(headerKey(h), i); });
    const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
    let nextCol = range.e.c + 1;
    const outCols = {};
    const headerStyleTemplate = pickHeaderStyleTemplate(ws) || { s: { font: { bold: true } } };
    SOURCE_RESULT_COLUMNS.forEach(header => {
      const outputHeader = OUTPUT_HEADERS[header] || header;
      const key = headerKey(outputHeader);
      const legacyKey = headerKey(header);
      if (headerMap.has(key)) outCols[header] = headerMap.get(key);
      else if (headerMap.has(legacyKey)) {
        outCols[header] = headerMap.get(legacyKey);
        headerMap.set(key, outCols[header]);
      } else { outCols[header] = nextCol; headerMap.set(key, nextCol); nextCol++; }
    });
    SOURCE_RESULT_COLUMNS.forEach(header => {
      const cellAddress = XLSX.utils.encode_cell({ r: 0, c: outCols[header] });
      const cell = { t: 's', v: sanitizeExcelText(OUTPUT_HEADERS[header] || header) };
      copyCellStyle(cell, headerStyleTemplate);
      ws[cellAddress] = cell;
    });
    outputRows.forEach((row, index) => {
      const excelRow = index + 1;
      SOURCE_RESULT_COLUMNS.forEach(header => {
        const value = row[header] == null ? '' : row[header];
        const cellAddress = XLSX.utils.encode_cell({ r: excelRow, c: outCols[header] });
        if (header === 'Auto Match Score') {
          ws[cellAddress] = { t: 'n', v: Number(value) || 0, z: '0.##"%"' };
        } else {
          const displayValue = header === 'Auto Match Status / Review Required' ? clientReviewStatus(value) : value;
          ws[cellAddress] = { t: 's', v: sanitizeExcelText(displayValue) };
        }
      });
    });
    range.e.c = Math.max(range.e.c, nextCol - 1);
    range.e.r = Math.max(range.e.r, outputRows.length);
    ws['!ref'] = XLSX.utils.encode_range(range);
     if (Array.isArray(ws['!cols'])) {
       while (ws['!cols'].length <= range.e.c) ws['!cols'].push({ wch: 24 });
     }



    // Preserve the original worksheet formatting and layout; remove any summary tab from an older output.
    if (workbook.Sheets['Auto - Summary']) {
      delete workbook.Sheets['Auto - Summary'];
      workbook.SheetNames = workbook.SheetNames.filter(name => name !== 'Auto - Summary');
    }
    if (workbook.Sheets['Auto - Ready']) {
      delete workbook.Sheets['Auto - Ready'];
      workbook.SheetNames = workbook.SheetNames.filter(name => name !== 'Auto - Ready');
    }
    for (const obsoleteSheet of ['Auto - Review Needed', 'Auto - Review Groups']) {
      if (workbook.Sheets[obsoleteSheet]) {
        delete workbook.Sheets[obsoleteSheet];
        workbook.SheetNames = workbook.SheetNames.filter(name => name !== obsoleteSheet);
      }
    }

    const clientSheetName = 'Client Report';
    for (const obsoleteSheet of [clientSheetName]) {
      if (workbook.Sheets[obsoleteSheet]) {
        delete workbook.Sheets[obsoleteSheet];
        workbook.SheetNames = workbook.SheetNames.filter(name => name !== obsoleteSheet);
      }
    }

    const totalRecords = outputRows.length;
    let highConfidenceCount = 0;
    let reviewRequiredCount = 0;
    let unresolvedCount = 0;
    outputRows.forEach(row => {
      const candidate = row ? row['Auto Candidate Service Code'] : '';
      const status = String((row && row['Auto Match Status / Review Required']) || '').toUpperCase();
      if (isBlank(candidate)) {
        unresolvedCount++;
        return;
      }
      const isHigh = status.includes('AUTO-APPROVED')
        || status.includes('HIGH-CONFIDENCE')
        || (status.includes('EXACT MATCH')
          && !status.includes('CATEGORY CONFLICT')
          && !status.includes('EXISTING CODE DISAGREEMENT')
          && !status.includes('AMBIGUOUS'));
      if (isHigh) highConfidenceCount++;
      else reviewRequiredCount++;
    });

    const clientHeaders = [
      'Vendor Name',
      'Original Vendor Service Name',
      'Vendor Service Code',
      'Vendor Charges',
      'Suggested Standardized Service Name',
      'Suggested Standard Code',
      'Standard Service Group',
      'Standard Service Subgroup',
      'Standard Service Vendor / Provider',
      'Standard Service Charges / Price',
      'Match Status',
      'Match Confidence / Score',
      'Match Explanation',
      'Review Reason'
    ];
    const clientAoa = [];
    clientAoa.push([sanitizeExcelText('Client Report - Service Code Match Results')]);
    clientAoa.push([]);
    clientAoa.push([sanitizeExcelText('Total records processed'), totalRecords]);
    clientAoa.push([sanitizeExcelText('High-confidence candidates'), highConfidenceCount]);
    clientAoa.push([sanitizeExcelText('Candidates requiring review'), reviewRequiredCount]);
    clientAoa.push([sanitizeExcelText('Unresolved records'), unresolvedCount]);
    clientAoa.push([]);
    const clientHeaderRow = clientAoa.length;
    clientAoa.push(clientHeaders.map(sanitizeExcelText));
    outputRows.forEach((row, index) => {
      const sourceRow = (sourceRows && sourceRows[index]) || {};
      const vendorName = text(sourceRow.vendorName || sourceRow.Vendor || sourceRow['Vendor Name'] || row['Vendor'] || row['Vendor Name'] || '');
      const originalServiceName = text(row['Original Service Name'] || sourceRow.rawName || sourceRow['Service Name'] || '');
      const vendorServiceCode = text(sourceRow.existingCode || sourceRow['Service Code'] || '');
      const vendorCharges = text(sourceRow.sourceCharges || sourceRow.charges || sourceRow['Vendor Charges'] || row['Vendor Charges'] || '');
      const suggestedStandardName = text(row['Auto Candidate Standardized Service Name'] || row['Auto Candidate Service Display Name'] || '');
      const suggestedCode = text(row['Auto Candidate Service Code'] || '');
      const standardGroup = text(row['Auto Candidate Group'] || '');
      const standardSubgroup = text(row['Auto Candidate Sub Group'] || '');
      const standardVendor = text(row['Auto Candidate Standard Service Vendor / Provider'] || row['Auto Candidate Standard Vendor'] || row['Standard Service Vendor / Provider'] || '');
      const standardCharges = text(row['Auto Candidate Standard Service Charges / Price'] || row['Auto Candidate Standard Charges'] || row['Standard Service Charges / Price'] || '');
      const matchStatus = clientReviewStatus(row['Auto Match Status / Review Required']);
      const score = Number(row['Auto Match Score']) || 0;
      const explanation = text(row['Clinical Equivalence Explanation'] || row['Text Match Evidence'] || row['Auto Match Method'] || '');
      const reviewReason = text(row['Decision Reason'] || row['Critical Differences'] || row['Missing Attributes'] || recommendedAction(row) || '');
      // Leave suggested standard-service fields blank when there is no reliable candidate.
      const hasCandidate = !isBlank(suggestedCode) || !isBlank(suggestedStandardName);
      clientAoa.push([
        sanitizeExcelText(vendorName),
        sanitizeExcelText(originalServiceName),
        sanitizeExcelText(vendorServiceCode),
        sanitizeExcelText(vendorCharges),
        sanitizeExcelText(hasCandidate ? suggestedStandardName : ''),
        sanitizeExcelText(hasCandidate ? suggestedCode : ''),
        sanitizeExcelText(hasCandidate ? standardGroup : ''),
        sanitizeExcelText(hasCandidate ? standardSubgroup : ''),
        sanitizeExcelText(hasCandidate ? standardVendor : ''),
        sanitizeExcelText(hasCandidate ? standardCharges : ''),
        sanitizeExcelText(matchStatus),
        score,
        sanitizeExcelText(explanation),
        sanitizeExcelText(reviewReason)
      ]);
    });
    const clientWorksheet = XLSX.utils.aoa_to_sheet(clientAoa);
    clientWorksheet['!cols'] = [
      { wch: 24 },
      { wch: 40 },
      { wch: 20 },
      { wch: 16 },
      { wch: 40 },
      { wch: 20 },
      { wch: 22 },
      { wch: 22 },
      { wch: 28 },
      { wch: 22 },
      { wch: 28 },
      { wch: 12 },
      { wch: 46 },
      { wch: 40 }
    ];
    const clientLastRow = clientAoa.length - 1;
    const clientLastCol = clientHeaders.length - 1;
    clientWorksheet['!autofilter'] = {
      ref: XLSX.utils.encode_range({ s: { r: clientHeaderRow, c: 0 }, e: { r: clientLastRow, c: clientLastCol } })
    };
    clientWorksheet['!freeze'] = {
      xSplit: 0,
      ySplit: clientHeaderRow + 1,
      topLeftCell: XLSX.utils.encode_cell({ r: clientHeaderRow + 1, c: 0 }),
      activePane: 'bottomLeft',
      state: 'frozen'
    };
    for (let c = 0; c < clientHeaders.length; c++) {
      const address = XLSX.utils.encode_cell({ r: clientHeaderRow, c });
      if (clientWorksheet[address]) {
        clientWorksheet[address].s = {
          font: { bold: true, color: { rgb: 'FFFFFF' } },
          fill: { patternType: 'solid', fgColor: { rgb: '4472C4' } },
          alignment: { horizontal: 'center', vertical: 'center', wrapText: true }
        };
      }
    }
    outputRows.forEach((row, index) => {
      const r = clientHeaderRow + 1 + index;
      const scoreAddress = XLSX.utils.encode_cell({ r, c: 11 });
      if (clientWorksheet[scoreAddress]) {
        clientWorksheet[scoreAddress].z = '0.##"%"';
        clientWorksheet[scoreAddress].s = { alignment: { horizontal: 'center' } };
      }
      const statusAddress = XLSX.utils.encode_cell({ r, c: 10 });
      if (clientWorksheet[statusAddress]) {
        clientWorksheet[statusAddress].s = {
          fill: { patternType: 'solid', fgColor: { rgb: reviewStatusFill(clientWorksheet[statusAddress].v) } },
          alignment: { wrapText: true, vertical: 'top' }
        };
      }
      for (let c = 0; c < clientHeaders.length; c++) {
        const address = XLSX.utils.encode_cell({ r, c });
        if (clientWorksheet[address] && c !== 10 && c !== 11) {
          clientWorksheet[address].s = Object.assign({}, clientWorksheet[address].s || {}, { alignment: { wrapText: true, vertical: 'top' } });
        }
      }
    });
    for (let r = 0; r <= 5; r++) {
      const labelAddress = XLSX.utils.encode_cell({ r, c: 0 });
      const valueAddress = XLSX.utils.encode_cell({ r, c: 1 });
      if (clientWorksheet[labelAddress] && r >= 2 && r <= 5) {
        clientWorksheet[labelAddress].s = { font: { bold: true } };
      }
      if (r === 0 && clientWorksheet[labelAddress]) {
        clientWorksheet[labelAddress].s = { font: { bold: true, size: 14, color: { rgb: '1F3864' } } };
      }
    }

    const auditSheetName = 'Technical Details';
    if (workbook.Sheets[auditSheetName]) {
      delete workbook.Sheets[auditSheetName];
      workbook.SheetNames = workbook.SheetNames.filter(name => name !== auditSheetName);
    }
    const auditHeaders = outputRows.length ? Object.keys(outputRows[0]) : [];
    const auditAoa = [auditHeaders.map(sanitizeExcelText)];
    outputRows.forEach(row => {
      auditAoa.push(auditHeaders.map(header => {
        const value = row && row[header];
        if (value == null) return '';
        if (header === 'Auto Match Score') return Number(value) || 0;
        return sanitizeExcelText(value);
      }));
    });
    const auditWorksheet = XLSX.utils.aoa_to_sheet(auditAoa);
    auditWorksheet['!cols'] = auditHeaders.map(() => ({ wch: 28 }));
    auditWorksheet['!autofilter'] = {
      ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(0, auditAoa.length - 1), c: Math.max(0, auditHeaders.length - 1) } })
    };
    auditWorksheet['!freeze'] = { xSplit: 0, ySplit: 1, topLeftCell: 'A2', activePane: 'bottomLeft', state: 'frozen' };
    for (let c = 0; c < auditHeaders.length; c++) {
      const address = XLSX.utils.encode_cell({ r: 0, c });
      if (auditWorksheet[address]) {
        auditWorksheet[address].s = { font: { bold: true, color: { rgb: 'FFFFFF' } }, fill: { patternType: 'solid', fgColor: { rgb: '4472C4' } }, alignment: { horizontal: 'center', vertical: 'center', wrapText: true } };
      }
    }
    workbook.Sheets[auditSheetName] = auditWorksheet;
    if (!workbook.SheetNames.includes(auditSheetName)) workbook.SheetNames.push(auditSheetName);
    workbook.Sheets[clientSheetName] = clientWorksheet;
    const remainingSheetNames = workbook.SheetNames.filter(name => name !== clientSheetName);
    workbook.SheetNames = [clientSheetName].concat(remainingSheetNames);

    if (workbook.Workbook) {
      if (workbook.Workbook.WBProps) {
        delete workbook.Workbook.WBProps.CodeName;
      }
      if (Array.isArray(workbook.Workbook.Sheets)) {
        workbook.Workbook.Sheets.forEach(sheet => {
          if (sheet) delete sheet.CodeName;
        });
      }
    }
    return workbook;
  }


  $('run-btn').addEventListener('click', async () => {
    if (!savedMaster || !sourceWorkbook) return;
    if (!window.XLSX) { setMessage($('source-message'), 'Excel library did not load. Refresh with an internet connection.', 'error'); return; }
    let sourceData;
    const high = Number($('high-threshold').value);
    const review = Number($('review-threshold').value);
    const localAiEnabled = $('local-ai-enabled').checked;
    const localAiModel = $('local-ai-model').value.trim();
    const localAiMaxNames = Number($('local-ai-max-names').value);
    if (!(review >= 0 && high >= review && high <= 100)) {
      setMessage($('source-message'), 'Thresholds must satisfy 0 ≤ review threshold ≤ high-confidence threshold ≤ 100.', 'error'); return;
    }
    if (localAiEnabled && (!localAiModel || !Number.isInteger(localAiMaxNames) || localAiMaxNames < 1 || localAiMaxNames > 1000)) {
      setMessage($('source-message'), 'Enter an installed local model name and a unique-name limit from 1 to 1,000.', 'error'); return;
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
      if (message.type === 'llm-progress') showProgress('Ranking review suggestions locally…', `${formatNumber(message.completed)} of ${formatNumber(message.total)} unique names`, message.percent);
      if (message.type === 'llm-status') setMessage($('local-ai-message'), message.message || '', message.kind || '');
      if (message.type === 'error') {
        showProgress('Matching stopped', message.error || 'An unexpected matching error occurred.', 0);
        setMessage($('source-message'), message.error || 'An unexpected error occurred.', 'error');
        $('run-btn').disabled = false;
        activeWorker.terminate(); activeWorker = null;
      }
      if (message.type === 'done') {
        try {
          showProgress('Writing Excel output…', 'Preparing the comparison and review sheets', 96);
          const rows = message.results;
          latestOutputWorkbook = buildOutputWorkbook(activeWorkbook, sourceSheetName, rows, sourceData.matrix, sourceRows);
          latestOutputName = `${sourceFileName.replace(/\.(xlsx|xlsm|xlsb|xls)$/i, '')}_AUTO_MATCHED.xlsx`;
          const assigned = rows.filter(row => !isBlank(row['Auto Candidate Service Code'])).length;
          const flagged = rows.filter(row => !String(row['Reviewer Decision'] || '').startsWith('Auto-Approved (100% exact)')).length;
          $('metric-total').textContent = formatNumber(rows.length);
          $('metric-assigned').textContent = formatNumber(assigned);
          $('metric-review').textContent = formatNumber(flagged);
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
      approvedMappings: savedMaster.approvedMappings || [],
      sourceRows,
      thresholds: { high, review },
      localAi: localAiEnabled ? {
        enabled: true,
        endpoint: 'http://localhost:11434',
        model: localAiModel,
        maxNames: localAiMaxNames
      } : { enabled: false }
    });
  });

  $('local-ai-enabled').addEventListener('change', () => {
    $('local-ai-fields').hidden = !$('local-ai-enabled').checked;
    setMessage($('local-ai-message'), $('local-ai-enabled').checked
      ? 'Local AI ranking is optional. Suggestions remain pending for manual verification.'
      : '');
  });

  $('download-btn').addEventListener('click', async () => {
    if (!latestOutputWorkbook) return;
    try {
      {
        const workbookData = XLSX.write(latestOutputWorkbook, { bookType: 'xlsx', type: 'array', compression: true });
        const blob = new Blob([workbookData], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = latestOutputName;
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
        URL.revokeObjectURL(url);
      }
      toast('Excel output download started');
    } catch (error) { toast(`Download failed: ${error.message}`); }
  });

  async function boot() {
    if (!window.XLSX) setMessage($('master-message'), 'Excel reader could not load from the SheetJS CDN. Check your internet connection and refresh.', 'error');
    await refreshSavedMaster();
  }
  if (typeof globalThis !== 'undefined') globalThis.buildOutputWorkbook = buildOutputWorkbook;
  if (typeof window !== 'undefined') window.buildOutputWorkbook = buildOutputWorkbook;
  boot().catch(error => setMessage($('master-message'), error.message, 'error'));
})();
