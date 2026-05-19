const APPS_KEY   = 'itracker_apps';
const RESUME_KEY = 'itracker_resume';
const SYNC_DISMISSED = 'itracker_sync_dismissed';

let editingId    = null;
let sortCol      = 'dateApplied';
let sortDir      = -1;
let pendingCL    = null;
let confirmResolve = () => {};
let syncFileHandle = null;  // File System Access API handle
let syncFileName   = null;

// ── IndexedDB for persisting the file handle ──────────────
function getDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('itracker_sync', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('meta');
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = reject;
  });
}
async function idbGet(key) {
  const db = await getDB();
  return new Promise(resolve => {
    const tx = db.transaction('meta', 'readonly');
    const req = tx.objectStore('meta').get(key);
    req.onsuccess = e => resolve(e.target.result ?? null);
    req.onerror = () => resolve(null);
  });
}
async function idbSet(key, val) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put(val, key);
    tx.oncomplete = resolve;
    tx.onerror = reject;
  });
}
async function idbDel(key) {
  const db = await getDB();
  return new Promise(resolve => {
    const tx = db.transaction('meta', 'readwrite');
    tx.objectStore('meta').delete(key);
    tx.oncomplete = resolve;
    tx.onerror = resolve;
  });
}

// ── Storage ───────────────────────────────────────────────
function loadApps() {
  try { return JSON.parse(localStorage.getItem(APPS_KEY) || '[]'); }
  catch { return []; }
}
function saveApps(apps) {
  localStorage.setItem(APPS_KEY, JSON.stringify(apps));
  writeToSyncFile();
}
function loadResume() {
  try { return JSON.parse(localStorage.getItem(RESUME_KEY) || 'null'); }
  catch { return null; }
}
function saveResume(r) {
  localStorage.setItem(RESUME_KEY, JSON.stringify(r));
  writeToSyncFile();
}

// ── Sync file (File System Access API) ───────────────────
async function writeToSyncFile() {
  if (!syncFileHandle) return;
  try {
    const perm = await syncFileHandle.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') {
      const req = await syncFileHandle.requestPermission({ mode: 'readwrite' });
      if (req !== 'granted') return;
    }
    const payload = JSON.stringify({ apps: loadApps(), resume: loadResume(), savedAt: new Date().toISOString() }, null, 2);
    const writable = await syncFileHandle.createWritable();
    await writable.write(payload);
    await writable.close();
    updateSyncStatus('synced');
  } catch (e) {
    console.warn('Sync write failed:', e);
    updateSyncStatus('error');
  }
}

async function readFromSyncFile() {
  if (!syncFileHandle) return false;
  try {
    const perm = await syncFileHandle.requestPermission({ mode: 'readwrite' });
    if (perm !== 'granted') { updateSyncStatus('stale'); return false; }
    const file = await syncFileHandle.getFile();
    const text = await file.text();
    const data = JSON.parse(text);
    if (Array.isArray(data.apps)) localStorage.setItem(APPS_KEY, JSON.stringify(data.apps));
    if (data.resume) localStorage.setItem(RESUME_KEY, JSON.stringify(data.resume));
    updateSyncStatus('synced');
    return true;
  } catch (e) {
    console.warn('Sync read failed:', e);
    updateSyncStatus('error');
    return false;
  }
}

async function connectNewSyncFile() {
  if (!window.showSaveFilePicker) {
    alert('Your browser does not support the File System Access API.\nTry Chrome or Edge instead.');
    return;
  }
  try {
    const handle = await window.showSaveFilePicker({
      suggestedName: 'internship-tracker-data.json',
      types: [{ description: 'JSON data file', accept: { 'application/json': ['.json'] } }],
    });
    syncFileHandle = handle;
    syncFileName = handle.name;
    await idbSet('fileHandle', handle);
    await idbSet('fileName', handle.name);
    await writeToSyncFile();
    renderSyncModal();
    toast('Sync file connected — save it to Dropbox/OneDrive to sync across devices');
  } catch (e) {
    if (e.name !== 'AbortError') toast('Could not connect sync file');
  }
}

async function openExistingSyncFile() {
  if (!window.showOpenFilePicker) {
    alert('Your browser does not support the File System Access API.\nTry Chrome or Edge instead.');
    return;
  }
  try {
    const [handle] = await window.showOpenFilePicker({
      types: [{ description: 'JSON data file', accept: { 'application/json': ['.json'] } }],
    });
    syncFileHandle = handle;
    syncFileName = handle.name;
    await idbSet('fileHandle', handle);
    await idbSet('fileName', handle.name);
    await readFromSyncFile();
    renderTable();
    renderSyncModal();
    toast('Loaded data from sync file');
  } catch (e) {
    if (e.name !== 'AbortError') toast('Could not open sync file');
  }
}

async function disconnectSync() {
  const ok = await confirm('Disconnect sync file?', 'Your data stays on this device. The sync file is not deleted.');
  if (!ok) return;
  syncFileHandle = null;
  syncFileName = null;
  await idbDel('fileHandle');
  await idbDel('fileName');
  updateSyncStatus('none');
  renderSyncModal();
  toast('Sync file disconnected');
}

function updateSyncStatus(state) {
  const dot = document.getElementById('sync-dot');
  const label = document.getElementById('sync-label');
  dot.className = 'sync-dot ' + state;
  const labels = { none: 'Local only', synced: syncFileName || 'Synced', stale: 'Permission needed', error: 'Sync error' };
  label.textContent = labels[state] || state;
}

// ── Sync modal ────────────────────────────────────────────
function openSyncModal() {
  renderSyncModal();
  document.getElementById('sync-overlay').classList.add('open');
}
function closeSyncModal(e) {
  if (e.target === document.getElementById('sync-overlay')) closeSyncModalDirect();
}
function closeSyncModalDirect() {
  document.getElementById('sync-overlay').classList.remove('open');
}

function renderSyncModal() {
  const body = document.getElementById('sync-modal-body');
  if (syncFileHandle) {
    body.innerHTML = `
      <div class="sync-connected">
        <div class="sc-label">Connected sync file</div>
        <div class="sc-name">📄 ${esc(syncFileName)}</div>
        <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px">
          Every change is automatically written to this file. Store it in your Dropbox, OneDrive, or Google Drive folder so it syncs across devices. On another device, open this tracker and use <strong>Open existing sync file</strong> to load it.
        </p>
        <div style="display:flex;gap:8px">
          <button class="btn btn-ghost btn-sm" onclick="writeToSyncFile();toast('Saved to sync file')">Force save</button>
          <button class="btn btn-danger btn-sm" onclick="disconnectSync()">Disconnect</button>
        </div>
      </div>
    `;
  } else {
    const fsa = !!window.showSaveFilePicker;
    body.innerHTML = `
      <p style="font-size:14px;color:var(--text-muted);margin-bottom:16px">
        By default, data is stored in this browser's local storage — it won't appear on other devices. Connect a sync file to fix that:
      </p>
      <div class="sync-option" onclick="connectNewSyncFile()">
        <h3>📂 Create a new sync file</h3>
        <p>Pick a location in your Dropbox / OneDrive / Google Drive. Your data will be saved there and synced automatically.</p>
      </div>
      <div class="sync-option" onclick="openExistingSyncFile()">
        <h3>🔗 Open an existing sync file</h3>
        <p>Already set this up on another device? Load the same .json file to pull in your data.</p>
      </div>
      ${!fsa ? `<p style="font-size:12px;color:#DC2626;margin-top:8px">⚠ Your browser doesn't support the File System API. Use Chrome or Edge for sync.</p>` : ''}
      <hr style="border:none;border-top:1px solid var(--border);margin:16px 0">
      <p style="font-size:13px;color:var(--text-muted)">
        <strong>Alternative:</strong> Use <em>Export JSON (full backup)</em> on one device and <em>Import JSON</em> on the other to manually transfer data.
      </p>
    `;
  }
}

// ── View switching ────────────────────────────────────────
function showView(v) {
  document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('nav button').forEach(el => el.classList.remove('active'));
  document.getElementById('view-' + v).classList.add('active');
  document.querySelectorAll('nav button')[v === 'apps' ? 0 : 1].classList.add('active');
  if (v === 'resume') renderResume();
  if (v === 'apps') renderTable();
}

// ── Stats ─────────────────────────────────────────────────
function renderStats() {
  const apps = loadApps();
  const c = { total: apps.length, applied: 0, interview: 0, offer: 0, rejected: 0 };
  apps.forEach(a => {
    if (a.status === 'applied' || a.status === 'phone') c.applied++;
    if (a.status === 'interview') c.interview++;
    if (a.status === 'offer') c.offer++;
    if (a.status === 'rejected') c.rejected++;
  });
  const colors = { total:'#4F46E5', applied:'#1D4ED8', interview:'#B45309', offer:'#065F46', rejected:'#B91C1C' };
  const labels = { total:'Total', applied:'In Progress', interview:'Interviews', offer:'Offers', rejected:'Rejected' };
  document.getElementById('stats-bar').innerHTML = Object.entries(c).map(([k, v]) =>
    `<div class="stat-card"><div class="num" style="color:${colors[k]}">${v}</div><div class="label">${labels[k]}</div></div>`
  ).join('');
}

// ── Table ─────────────────────────────────────────────────
const STATUS_META = {
  wishlist:  { label:'Wishlist',     cls:'badge-wishlist' },
  applied:   { label:'Applied',      cls:'badge-applied' },
  phone:     { label:'Phone Screen', cls:'badge-phone' },
  interview: { label:'Interview',    cls:'badge-interview' },
  offer:     { label:'Offer',        cls:'badge-offer' },
  rejected:  { label:'Rejected',     cls:'badge-rejected' },
  withdrawn: { label:'Withdrawn',    cls:'badge-withdrawn' },
};

function formatDate(d) {
  if (!d) return '—';
  const [y, m, day] = d.split('-');
  return `${m}/${day}/${y}`;
}

function renderTable() {
  renderStats();
  const query = document.getElementById('search-input').value.toLowerCase();
  const fs = document.getElementById('filter-status').value;
  let apps = loadApps();
  if (query) apps = apps.filter(a => a.company.toLowerCase().includes(query) || a.role.toLowerCase().includes(query));
  if (fs) apps = apps.filter(a => a.status === fs);
  apps.sort((a, b) => {
    let va = (a[sortCol] || '').toString().toLowerCase();
    let vb = (b[sortCol] || '').toString().toLowerCase();
    return va < vb ? sortDir : va > vb ? -sortDir : 0;
  });

  const tbody = document.getElementById('apps-tbody');
  if (apps.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="3"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="16" x2="12" y2="16"/></svg>
      <p>No applications yet. Click <strong>+ Add Application</strong> to get started.</p>
    </div></td></tr>`;
    return;
  }
  tbody.innerHTML = apps.map(a => {
    const sm = STATUS_META[a.status] || STATUS_META.applied;
    return `<tr>
      <td><div class="company-name">${esc(a.company)}</div></td>
      <td><div class="role-name">${esc(a.role)}</div></td>
      <td><span class="badge ${sm.cls}">${sm.label}</span>${a.coverLetter ? ' <span title="Has cover letter" style="font-size:11px;color:#64748B">📎</span>' : ''}</td>
      <td>${formatDate(a.dateApplied)}</td>
      <td>${formatDate(a.deadline)}</td>
      <td><div class="actions">
        <button class="btn btn-ghost btn-sm" onclick="openDetail('${a.id}')">View</button>
        <button class="btn btn-ghost btn-sm" onclick="openEditModal('${a.id}')">Edit</button>
        <button class="btn btn-danger btn-sm" onclick="deleteApp('${a.id}')">Delete</button>
      </div></td>
    </tr>`;
  }).join('');
}

function sortBy(col) {
  if (sortCol === col) sortDir *= -1; else { sortCol = col; sortDir = 1; }
  renderTable();
}
function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Add/Edit Modal ────────────────────────────────────────
function openAddModal() {
  editingId = null; pendingCL = null;
  document.getElementById('modal-title').textContent = 'Add Application';
  document.getElementById('modal-save-btn').textContent = 'Add Application';
  document.getElementById('app-form').reset();
  document.getElementById('f-dateApplied').value = new Date().toISOString().slice(0,10);
  document.getElementById('interview-dates-container').innerHTML = '';
  resetCLUpload();
  document.getElementById('modal-overlay').classList.add('open');
}
function openEditModal(id) {
  const a = loadApps().find(x => x.id === id);
  if (!a) return;
  editingId = id; pendingCL = a.coverLetter || null;
  document.getElementById('modal-title').textContent = 'Edit Application';
  document.getElementById('modal-save-btn').textContent = 'Save Changes';
  document.getElementById('f-company').value = a.company || '';
  document.getElementById('f-role').value = a.role || '';
  document.getElementById('f-status').value = a.status || 'applied';
  document.getElementById('f-dateApplied').value = a.dateApplied || '';
  document.getElementById('f-deadline').value = a.deadline || '';
  document.getElementById('f-url').value = a.url || '';
  document.getElementById('f-contactName').value = a.contactName || '';
  document.getElementById('f-contactEmail').value = a.contactEmail || '';
  document.getElementById('f-notes').value = a.notes || '';
  document.getElementById('interview-dates-container').innerHTML = '';
  (a.interviewDates || []).forEach(d => addInterviewDate(d));
  a.coverLetter ? setCLDisplay(a.coverLetter.name) : resetCLUpload();
  document.getElementById('modal-overlay').classList.add('open');
}
function closeModal(e) { if (e.target === document.getElementById('modal-overlay')) closeModalDirect(); }
function closeModalDirect() { document.getElementById('modal-overlay').classList.remove('open'); pendingCL = null; }

function saveApplication(e) {
  e.preventDefault();
  const apps = loadApps();
  const interviewDates = [...document.querySelectorAll('.interview-date-input')].map(i => i.value).filter(Boolean);
  const app = {
    company: document.getElementById('f-company').value.trim(),
    role: document.getElementById('f-role').value.trim(),
    status: document.getElementById('f-status').value,
    dateApplied: document.getElementById('f-dateApplied').value,
    deadline: document.getElementById('f-deadline').value,
    url: document.getElementById('f-url').value.trim(),
    contactName: document.getElementById('f-contactName').value.trim(),
    contactEmail: document.getElementById('f-contactEmail').value.trim(),
    interviewDates,
    notes: document.getElementById('f-notes').value.trim(),
    coverLetter: pendingCL || null,
  };
  if (editingId) {
    const idx = apps.findIndex(x => x.id === editingId);
    if (idx !== -1) apps[idx] = { ...apps[idx], ...app };
    saveApps(apps); toast('Application updated');
  } else {
    app.id = Date.now().toString();
    app.createdAt = new Date().toISOString();
    apps.push(app); saveApps(apps); toast('Application added');
  }
  closeModalDirect(); renderTable();
}

// ── Interview dates ───────────────────────────────────────
function addInterviewDate(val = '') {
  const row = document.createElement('div');
  row.className = 'interview-date-row';
  row.innerHTML = `<input type="datetime-local" class="interview-date-input" value="${val}">
    <button type="button" onclick="this.parentElement.remove()">×</button>`;
  document.getElementById('interview-dates-container').appendChild(row);
}

// ── Cover Letter ──────────────────────────────────────────
function handleCLUpload(e) {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { toast('File too large (max 5 MB)'); return; }
  const reader = new FileReader();
  reader.onload = ev => { pendingCL = { name: file.name, data: ev.target.result, type: file.type }; setCLDisplay(file.name); };
  reader.readAsDataURL(file);
}
function setCLDisplay(name) {
  document.getElementById('cl-upload-area').classList.add('has-file');
  document.getElementById('cl-upload-text').innerHTML =
    `📎 <span class="file-name">${esc(name)}</span> <span style="color:#64748B;font-size:12px">(click to replace)</span>`;
}
function resetCLUpload() {
  document.getElementById('cl-upload-area').classList.remove('has-file');
  document.getElementById('cl-upload-text').textContent = 'Click to upload cover letter (PDF, DOCX)';
  document.getElementById('f-coverLetter').value = '';
}

// ── Detail ────────────────────────────────────────────────
function openDetail(id) {
  const a = loadApps().find(x => x.id === id);
  if (!a) return;
  const sm = STATUS_META[a.status] || STATUS_META.applied;
  const interviewHtml = (a.interviewDates || []).length
    ? a.interviewDates.map(d => `<div>${new Date(d).toLocaleString()}</div>`).join('')
    : '<span style="color:var(--text-muted)">None scheduled</span>';
  const clHtml = a.coverLetter
    ? `<button class="btn btn-ghost btn-sm" onclick="downloadFile(${JSON.stringify(JSON.stringify(a.coverLetter))})">⬇ Download Cover Letter</button>`
    : '<span style="color:var(--text-muted);font-size:13px">No cover letter attached</span>';
  document.getElementById('detail-modal-content').innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">
      <div><h2 style="font-size:20px">${esc(a.company)}</h2><div style="color:var(--text-muted);font-size:14px;margin-top:2px">${esc(a.role)}</div></div>
      <span class="badge ${sm.cls}" style="font-size:13px">${sm.label}</span>
    </div>
    <div class="detail-section"><h3>Details</h3>
      <div class="detail-grid">
        <div class="detail-item"><div class="di-label">Date Applied</div><div class="di-val">${formatDate(a.dateApplied)}</div></div>
        <div class="detail-item"><div class="di-label">Deadline</div><div class="di-val">${formatDate(a.deadline)}</div></div>
        <div class="detail-item"><div class="di-label">Contact</div><div class="di-val">${esc(a.contactName)||'—'}</div></div>
        <div class="detail-item"><div class="di-label">Contact Email</div><div class="di-val">${a.contactEmail?`<a href="mailto:${esc(a.contactEmail)}">${esc(a.contactEmail)}</a>`:'—'}</div></div>
        <div class="detail-item" style="grid-column:1/-1"><div class="di-label">Job Posting</div><div class="di-val">${a.url?`<a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.url)}</a>`:'—'}</div></div>
      </div>
    </div>
    <div class="detail-section"><h3>Interview Dates</h3>${interviewHtml}</div>
    <div class="detail-section"><h3>Cover Letter</h3>${clHtml}</div>
    ${a.notes?`<div class="detail-section"><h3>Notes</h3><div class="detail-notes">${esc(a.notes)}</div></div>`:''}
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeDetail()">Close</button>
      <button class="btn btn-primary" onclick="closeDetail();openEditModal('${a.id}')">Edit</button>
    </div>`;
  document.getElementById('detail-overlay').classList.add('open');
}
function closeDetail(e) {
  if (!e || e.target === document.getElementById('detail-overlay'))
    document.getElementById('detail-overlay').classList.remove('open');
}
function downloadFile(jsonStr) {
  const f = JSON.parse(jsonStr);
  const a = document.createElement('a'); a.href = f.data; a.download = f.name; a.click();
}

// ── Delete ────────────────────────────────────────────────
async function deleteApp(id) {
  const a = loadApps().find(x => x.id === id);
  if (!a) return;
  if (!await confirm(`Delete application for ${a.role} at ${a.company}?`, 'This cannot be undone.')) return;
  saveApps(loadApps().filter(x => x.id !== id));
  renderTable(); toast('Application deleted');
}
function confirm(title, msg) {
  return new Promise(resolve => {
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-msg').textContent = msg;
    document.getElementById('confirm-overlay').classList.add('open');
    confirmResolve = val => { document.getElementById('confirm-overlay').classList.remove('open'); resolve(val); };
  });
}

// ── Resume ────────────────────────────────────────────────
function renderResume() {
  const r = loadResume();
  const section = document.getElementById('resume-section');
  if (r) {
    const isPDF = r.type === 'application/pdf' || r.name.endsWith('.pdf');
    const preview = isPDF
      ? `<iframe src="${r.data}" style="width:100%;height:700px;border:1px solid var(--border);border-radius:8px;margin-bottom:16px"></iframe>`
      : `<div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:20px;text-align:center;color:var(--text-muted);margin-bottom:16px;font-size:14px">Preview not available for DOCX — download to view</div>`;
    section.innerHTML = `
      <div class="resume-current">
        <div class="resume-icon">📄</div>
        <div class="resume-info"><div class="rname">${esc(r.name)}</div><div class="rdate">Uploaded ${new Date(r.uploadedAt).toLocaleDateString()}</div></div>
        <div class="resume-actions">
          <button class="btn btn-ghost btn-sm" onclick="downloadResume()">⬇ Download</button>
          <button class="btn btn-danger btn-sm" onclick="deleteResume()">Remove</button>
        </div>
      </div>
      ${preview}
      <label class="big-upload" style="padding:20px">
        <input type="file" accept=".pdf,.docx,.doc" onchange="uploadResume(event)">
        <p><strong>Replace resume</strong> — click to upload a new file</p>
      </label>`;
  } else {
    section.innerHTML = `
      <label class="big-upload">
        <input type="file" accept=".pdf,.docx,.doc" onchange="uploadResume(event)">
        <div class="upload-icon">📤</div>
        <p><strong>Click to upload your resume</strong></p>
        <p style="margin-top:6px">PDF or DOCX, up to 5 MB</p>
      </label>`;
  }
}
function uploadResume(e) {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { toast('File too large (max 5 MB)'); return; }
  const reader = new FileReader();
  reader.onload = ev => {
    saveResume({ name: file.name, data: ev.target.result, type: file.type, uploadedAt: new Date().toISOString() });
    renderResume(); toast('Resume uploaded');
  };
  reader.readAsDataURL(file);
}
function downloadResume() {
  const r = loadResume(); if (!r) return;
  const a = document.createElement('a'); a.href = r.data; a.download = r.name; a.click();
}
async function deleteResume() {
  if (!await confirm('Remove resume?', 'Your resume will be removed from the tracker.')) return;
  localStorage.removeItem(RESUME_KEY);
  writeToSyncFile();
  renderResume(); toast('Resume removed');
}

// ── Export: XLSX ──────────────────────────────────────────
function exportXLSX() {
  const apps = loadApps();
  const rows = apps.map(a => ({
    'Company':         a.company || '',
    'Role':            a.role || '',
    'Status':          (STATUS_META[a.status] || {}).label || a.status || '',
    'Date Applied':    a.dateApplied || '',
    'Deadline':        a.deadline || '',
    'Job URL':         a.url || '',
    'Contact Name':    a.contactName || '',
    'Contact Email':   a.contactEmail || '',
    'Interview Dates': (a.interviewDates || []).join('; '),
    'Has Cover Letter': a.coverLetter ? 'Yes' : 'No',
    'Notes':           a.notes || '',
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [20,28,14,14,14,40,20,28,30,16,40].map(w => ({ wch: w }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Applications');
  XLSX.writeFile(wb, `internship-tracker-${new Date().toISOString().slice(0,10)}.xlsx`);
}

// ── Export: JSON ──────────────────────────────────────────
function exportJSON() {
  const data = { apps: loadApps(), resume: loadResume(), exportedAt: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `internship-tracker-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
}

// ── Import: JSON ──────────────────────────────────────────
function importData(e) {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = async ev => {
    try {
      const data = JSON.parse(ev.target.result);
      if (!await confirm('Import data?', 'This will merge imported applications with your existing data.')) return;
      if (Array.isArray(data.apps)) {
        const existing = loadApps();
        const ids = new Set(existing.map(a => a.id));
        saveApps([...existing, ...data.apps.filter(a => !ids.has(a.id))]);
      }
      if (data.resume) saveResume(data.resume);
      renderTable(); toast(`Imported ${data.apps?.length || 0} applications`);
    } catch { toast('Invalid file format'); }
    e.target.value = '';
  };
  reader.readAsText(file);
}

// ── Export dropdown ───────────────────────────────────────
function toggleExportMenu(e) {
  e.stopPropagation();
  document.getElementById('export-menu').classList.toggle('open');
}
function closeExportMenu() { document.getElementById('export-menu').classList.remove('open'); }
document.addEventListener('click', closeExportMenu);

// ── Toast ─────────────────────────────────────────────────
let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
}

// ── Welcome modal ─────────────────────────────────────────
function openWelcome() { document.getElementById('welcome-overlay').classList.add('open'); }
function closeWelcome() {
  document.getElementById('welcome-overlay').classList.remove('open');
  localStorage.setItem('itracker_welcomed', '1');
}

// ── Help modal ────────────────────────────────────────────
function openHelpModal() { document.getElementById('help-overlay').classList.add('open'); }
function closeHelpModal() { document.getElementById('help-overlay').classList.remove('open'); }
function closeHelp(e) { if (e.target === document.getElementById('help-overlay')) closeHelpModal(); }

// ── Init ──────────────────────────────────────────────────
async function init() {
  const handle = await idbGet('fileHandle');
  const name   = await idbGet('fileName');
  if (handle) {
    syncFileHandle = handle;
    syncFileName   = name || handle.name;
    const loaded = await readFromSyncFile();
    if (!loaded) updateSyncStatus('stale');
  } else {
    updateSyncStatus('none');
    if (!localStorage.getItem(SYNC_DISMISSED)) {
      document.getElementById('sync-banner').classList.add('show');
    }
  }
  renderTable();
  if (!localStorage.getItem('itracker_welcomed')) {
    document.getElementById('welcome-overlay').classList.add('open');
  }
}

init();
