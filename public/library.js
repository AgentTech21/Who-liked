const accountList = document.querySelector('#account-list');
const accountCount = document.querySelector('#account-count');
const addForm = document.querySelector('#add-form');
const newHandlesInput = document.querySelector('#new-handles');
const addButton = document.querySelector('#add-button');
const libraryError = document.querySelector('#library-error');
const updateSelectedButton = document.querySelector('#update-selected');
const refreshAllButton = document.querySelector('#refresh-all');
const syncStatus = document.querySelector('#sync-status');
const syncSummary = document.querySelector('#sync-summary');
const syncCurrent = document.querySelector('#sync-current');
const syncAccountProgress = document.querySelector('#sync-account-progress');

let accounts = [];
let pollTimer = null;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function setError(message) {
  libraryError.textContent = message;
  libraryError.hidden = !message;
}

function formatDate(value) {
  if (!value) return 'Never checked';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown date' : date.toLocaleString();
}

function formatElapsed(startedAt, finishedAt) {
  if (!startedAt) return '';
  const seconds = Math.max(0, Math.floor(((finishedAt ? Date.parse(finishedAt) : Date.now()) - Date.parse(startedAt)) / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function renderAccounts() {
  accountCount.textContent = `${accounts.length} account${accounts.length === 1 ? '' : 's'}`;
  if (!accounts.length) {
    accountList.innerHTML = '<p class="library-empty">Nothing saved yet. Add usernames above to make the first local archive.</p>';
    updateSelectedButton.disabled = true;
    refreshAllButton.disabled = true;
    return;
  }
  const defaultSelection = new Set(accounts.filter(account => account.repostCount > 0).slice(0, 12).map(account => account.handle));
  accountList.innerHTML = accounts.map(account => {
    const empty = account.repostCount === 0;
    const state = account.lastError ? 'Needs attention' : empty ? 'No reposts found' : account.complete ? 'Full history saved' : 'Initial scan incomplete';
    const statusClass = account.lastError ? 'account-state error' : 'account-state';
    const error = account.lastError ? `<span class="account-state error">${escapeHtml(account.lastError)}</span>` : '';
    return `<div class="account-row">
      <input class="sync-select" type="checkbox" value="${escapeHtml(account.handle)}" ${defaultSelection.has(account.handle) ? 'checked' : ''} aria-label="Select @${escapeHtml(account.handle)}">
      <span class="account-name">@${escapeHtml(account.handle)}</span>
      <div class="account-meta"><strong>${Number(account.repostCount).toLocaleString()} saved reposts</strong><span class="${statusClass}">${state}</span>${error}<span class="account-state">Checked ${escapeHtml(formatDate(account.lastCheckedAt))}${account.lastAddedCount ? ` · +${account.lastAddedCount} last update` : ''}</span></div>
      <button class="remove-account" type="button" data-remove="${escapeHtml(account.handle)}">Remove</button>
    </div>`;
  }).join('');
  updateSelectedButton.disabled = false;
  refreshAllButton.disabled = accounts.length === 0;
  accountList.querySelectorAll('[data-remove]').forEach(button => button.addEventListener('click', () => removeAccount(button.dataset.remove)));
}

async function refreshLibrary() {
  const response = await fetch('/api/accounts');
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not read the local library.');
  accounts = data.accounts || [];
  renderAccounts();
}

function renderSync(job, lastSync) {
  if (!job) {
    syncStatus.textContent = lastSync ? lastSync.status.replaceAll('_', ' ') : 'Idle';
    syncSummary.textContent = lastSync ? `Last sync finished ${formatDate(lastSync.finishedAt)}.` : 'No repost scan is running.';
    syncCurrent.textContent = '';
    syncAccountProgress.innerHTML = '';
    return;
  }

  syncStatus.textContent = job.status.replaceAll('_', ' ');
  const elapsed = formatElapsed(job.startedAt, job.finishedAt);
  syncSummary.textContent = `${job.completedAccounts} of ${job.totalAccounts} accounts finished · ${job.pagesFetched} pages checked · ${elapsed} elapsed`;
  if (job.currentAccount) {
    const current = job.currentAccount;
    syncCurrent.textContent = `@${current.handle} · ${current.mode} · page ${current.pages} · ${current.fetched.toLocaleString()} new reposts seen${current.foundResumeBoundary ? ' · passed the saved checkpoint' : current.foundExisting ? ' · reached saved history' : ''}`;
  } else if (job.status === 'running') {
    syncCurrent.textContent = 'Starting browser and preparing the next account…';
  } else {
    syncCurrent.textContent = job.error || '';
  }
  syncAccountProgress.innerHTML = job.accounts.map(account => {
    const detail = account.error
      ? `<span class="sync-error">${escapeHtml(account.error)}</span>`
      : `${account.pages} pages · ${account.fetched.toLocaleString()} seen · ${account.added.toLocaleString()} saved`;
    return `<div class="sync-account-row"><span>@${escapeHtml(account.handle)} · ${escapeHtml(account.status.replaceAll('_', ' '))}</span><span>${detail}</span></div>`;
  }).join('');
}

async function pollSync() {
  try {
    const response = await fetch('/api/sync/status');
    const data = await response.json();
    renderSync(data.job, data.lastSync);
    const running = data.job?.status === 'running';
    addButton.disabled = running;
    updateSelectedButton.disabled = running || accounts.length === 0;
    refreshAllButton.disabled = running || accounts.length === 0;
    if (!running) {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      if (data.job?.finishedAt) await refreshLibrary().catch(() => {});
    }
  } catch (error) {
    syncStatus.textContent = 'Status unavailable';
    syncCurrent.textContent = error.message;
  }
}

function beginPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollSync();
  pollTimer = setInterval(pollSync, 1200);
}

async function startSync(handles) {
  if (!handles.length) return setError('Choose at least one account to sync.');
  setError('');
  addButton.disabled = true;
  updateSelectedButton.disabled = true;
  refreshAllButton.disabled = true;
  try {
    const response = await fetch('/api/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handles })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not start the repost sync.');
    beginPolling();
  } catch (error) {
    setError(error.message);
    addButton.disabled = false;
    updateSelectedButton.disabled = false;
    refreshAllButton.disabled = false;
  }
}

async function removeAccount(handle) {
  if (!confirm(`Remove @${handle} and its saved reposts from this server?`)) return;
  try {
    const response = await fetch(`/api/accounts/${encodeURIComponent(handle)}`, { method: 'DELETE' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not remove account.');
    await refreshLibrary();
  } catch (error) {
    setError(error.message);
  }
}

addForm.addEventListener('submit', event => {
  event.preventDefault();
  const handles = [...new Set(newHandlesInput.value.split(/[\n,\s]+/).map(value => value.trim().replace(/^@/, '')).filter(Boolean))];
  if (handles.length > 12) return setError('Load up to 12 new accounts at a time.');
  startSync(handles);
});

updateSelectedButton.addEventListener('click', () => {
  const handles = [...accountList.querySelectorAll('.sync-select:checked')].map(input => input.value);
  startSync(handles);
});

refreshAllButton.addEventListener('click', () => {
  startSync(accounts.map(account => account.handle));
});

refreshLibrary().catch(error => setError(error.message));
pollSync();
