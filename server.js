const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 3004);
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const LIBRARY_PATH = path.join(DATA_DIR, 'repost-library.json');
const MAX_HANDLES = 12;

let library = { version: 1, accounts: {} };
let storageError = null;
let syncJob = null;
let lastSyncSummary = null;

async function loadLibrary() {
  await fs.promises.mkdir(DATA_DIR, { recursive: true });
  try {
    const saved = JSON.parse(await fs.promises.readFile(LIBRARY_PATH, 'utf8'));
    if (saved?.version !== 1 || !saved.accounts || typeof saved.accounts !== 'object') {
      throw new Error('Library file has an unsupported format.');
    }
    library = saved;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

const libraryReady = loadLibrary().catch(error => {
  storageError = error.message;
  console.error(`Could not load local repost library: ${error.message}`);
});

async function saveLibrary() {
  await fs.promises.mkdir(DATA_DIR, { recursive: true });
  const temporaryPath = `${LIBRARY_PATH}.${process.pid}.tmp`;
  await fs.promises.writeFile(temporaryPath, JSON.stringify(library), 'utf8');
  await fs.promises.rename(temporaryPath, LIBRARY_PATH);
  storageError = null;
}

function accountSummaries() {
  return Object.values(library.accounts).map(account => ({
    handle: account.handle,
    repostCount: account.reposts.length,
    complete: Boolean(account.complete),
    firstLoadedAt: account.firstLoadedAt || null,
    lastCheckedAt: account.lastCheckedAt || null,
    lastAddedCount: account.lastAddedCount || 0,
    lastError: account.lastError || null
  })).sort((a, b) => a.handle.localeCompare(b.handle));
}

function totalStoredReposts() {
  return Object.values(library.accounts).reduce((sum, account) => sum + account.reposts.length, 0);
}

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function json(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(JSON.stringify(value));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 10_000) {
        reject(new Error('Request too large.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); }
      catch { reject(new Error('Send valid JSON.')); }
    });
    req.on('error', reject);
  });
}

function normalizeHandles(input, minimum = 2, maximum = MAX_HANDLES) {
  if (!Array.isArray(input)) throw new Error('Add at least two TikTok usernames.');
  const handles = [...new Set(input.map(value => String(value).trim().replace(/^@/, '')).filter(Boolean))];
  if (handles.length < minimum) throw new Error(minimum === 1 ? 'Add at least one TikTok username.' : 'Add at least two different TikTok usernames.');
  if (handles.length > maximum) throw new Error(`Add no more than ${maximum} accounts at a time.`);
  for (const handle of handles) {
    if (!/^[A-Za-z0-9._]{1,30}$/.test(handle)) throw new Error(`“${handle}” doesn’t look like a TikTok username.`);
  }
  return handles;
}

function normalizeItem(item) {
  const id = String(item?.id || item?.aweme_id || '');
  const creator = String(item?.author?.uniqueId || item?.author?.unique_id || '');
  if (!/^\d{15,25}$/.test(id) || !creator) return null;
  return { id, creator, description: String(item.desc || '').slice(0, 500) };
}

function extractProfileData(documentData) {
  const scopes = documentData?.__DEFAULT_SCOPE__ || {};
  const userDetail = scopes['webapp.user-detail'] || {};
  const user = userDetail.userInfo?.user || {};
  return {
    secUid: String(user.secUid || ''),
    userId: String(user.id || '')
  };
}

async function scrapeOne(browser, handle, { knownIds = [], resumeUntilId = null, resumeCursor = null, onProgress = () => {} } = {}) {
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' }
  });
  const page = await context.newPage();
  const reposts = new Map();
  const known = new Set(knownIds);
  let firstXhrUrl = '';
  let hasMore = false;
  let nextCursor = null;
  let statusCode = 0;
  let responseCount = 0;
  let paginationError = '';
  let foundKnown = false;
  let foundResumeBoundary = !resumeUntilId || resumeCursor !== null;
  let ingestQueue = Promise.resolve();

  function reportProgress() {
    try {
      onProgress({
        pages: responseCount,
        fetched: reposts.size,
        foundKnown,
        foundResumeBoundary,
        hasMore,
        nextCursor,
        reposts: [...reposts.values()]
      });
    } catch {}
  }

  function ingest(payload) {
    statusCode = Number(payload?.statusCode ?? payload?.status_code ?? 0);
    for (const item of Array.isArray(payload?.itemList) ? payload.itemList : []) {
      const normalized = normalizeItem(item);
      if (!normalized) continue;
      if (known.has(normalized.id)) {
        foundKnown = true;
        if (normalized.id === resumeUntilId) foundResumeBoundary = true;
      }
      else reposts.set(normalized.id, normalized);
    }
    if (typeof payload?.hasMore === 'boolean') hasMore = payload.hasMore;
    const cursor = payload?.maxCursor ?? payload?.cursor;
    if (cursor !== undefined && cursor !== null) nextCursor = cursor;
    reportProgress();
  }

  page.on('response', response => {
    if (!/\/api\/repost\/item_list/i.test(response.url())) return;
    responseCount += 1;
    if (!firstXhrUrl) firstXhrUrl = response.url();
    reportProgress();
    ingestQueue = ingestQueue.then(async () => {
      if (response.status() >= 400) {
        statusCode = response.status();
        return;
      }
      try { ingest(await response.json()); } catch {}
    });
  });

  try {
    await page.route('**/*', route => {
      const type = route.request().resourceType();
      if (type === 'image' || type === 'media' || type === 'font') return route.abort();
      return route.continue();
    });

    await page.goto(`https://www.tiktok.com/@${encodeURIComponent(handle)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000
    });
    await page.waitForTimeout(2200);

    const state = await page.evaluate(() => {
      const script = document.querySelector('script#__UNIVERSAL_DATA_FOR_REHYDRATION__');
      let data = null;
      try { data = script?.textContent ? JSON.parse(script.textContent) : null; } catch {}
      return {
        title: document.title,
        body: (document.body?.innerText || '').slice(0, 2500),
        data
      };
    }).catch(() => ({ title: '', body: '', data: null }));

    if (/captcha|verify|security/i.test(state.title) || /drag the slider|verify to continue|security verification/i.test(state.body)) {
      return { handle, reposts: [], error: 'TikTok presented a verification challenge to the headless browser.' };
    }

    const profile = extractProfileData(state.data);
    const fetchDirectPage = cursor => page.evaluate(async ({ secUid, userId, cursor }) => {
      const url = new URL('/api/repost/item_list/', location.origin);
      url.searchParams.set('aid', '1988');
      url.searchParams.set('count', '30');
      url.searchParams.set('cursor', String(cursor));
      url.searchParams.set('secUid', secUid);
      if (userId) url.searchParams.set('userId', userId);
      url.searchParams.set('coverFormat', '2');
      url.searchParams.set('needPinnedItemIds', 'false');
      url.searchParams.set('post_item_list_request_type', '0');
      try {
        const response = await fetch(url, { credentials: 'include' });
        const body = await response.json().catch(() => null);
        return { status: response.status, url: response.url, body };
      } catch { return null; }
    }, { ...profile, cursor });

    let directCursorMode = false;
    if (resumeCursor !== null && resumeCursor !== undefined && !profile.secUid) {
      paginationError = 'TikTok profile data did not include an ID needed to resume the saved cursor.';
    }
    if (resumeCursor !== null && resumeCursor !== undefined && profile.secUid) {
      const resumed = await fetchDirectPage(resumeCursor).catch(() => null);
      const payload = resumed?.body;
      if (resumed?.status < 400 && payload && Number(payload.statusCode ?? payload.status_code ?? 0) === 0 && Array.isArray(payload.itemList)) {
        firstXhrUrl ||= resumed.url;
        ingest(payload);
        directCursorMode = true;
      } else if (resumed?.status === 429) {
        paginationError = 'TikTok rate limited the saved-cursor request (HTTP 429). Wait before trying again.';
      } else {
        paginationError = 'TikTok could not continue from the saved repost cursor.';
      }
      await ingestQueue;
    }

    const responsePromise = directCursorMode || paginationError ? null : page.waitForResponse(response => /\/api\/repost\/item_list/i.test(response.url()), { timeout: 12_000 }).catch(() => null);
    let clickedTab = false;
    for (const selector of directCursorMode || paginationError ? [] : ['[role="tab"]', '[data-e2e="reposts-tab"]', '[data-e2e="user-post-item-list-repost"]']) {
      const candidates = page.locator(selector);
      for (let index = 0; index < await candidates.count().catch(() => 0); index += 1) {
        const candidate = candidates.nth(index);
        const text = await candidate.innerText().catch(() => '');
        if (!/reposts?/i.test(text)) continue;
        if (!await candidate.isVisible().catch(() => false)) continue;
        await candidate.scrollIntoViewIfNeeded().catch(() => {});
        await candidate.click({ timeout: 5000 }).catch(() => {});
        clickedTab = true;
        break;
      }
      if (clickedTab) break;
    }

    let firstResponse = null;
    if (clickedTab && responsePromise) firstResponse = await responsePromise;
    if (firstResponse && firstResponse.status() < 400) {
      try { ingest(await firstResponse.json()); } catch {}
      firstXhrUrl ||= firstResponse.url();
    }

    await ingestQueue;

    // TikTok sometimes omits the tab from the page DOM. Repostify's flow
    // falls back to the same web endpoint from inside the page session.
    if (!responseCount && profile.secUid && !paginationError) {
      const direct = await fetchDirectPage(0).catch(() => null);
      if (direct?.body && direct.status < 400) {
        firstXhrUrl ||= direct.url;
        ingest(direct.body);
      }
    }
    await ingestQueue;
    if (statusCode !== 0) {
      paginationError = `TikTok returned repost API status ${statusCode}.`;
    }

    // TikTok serves newest-first pages. Reuse the profile's natural scroll
    // pagination: this makes TikTok create and sign each next-page request.
    const stopAtKnown = () => !resumeUntilId && foundKnown;
    if (!paginationError && !stopAtKnown() && hasMore && (nextCursor === null || !firstXhrUrl)) {
      paginationError = 'TikTok indicated there are more reposts but did not provide a usable page cursor.';
    }
    while (!paginationError && !stopAtKnown() && hasMore && nextCursor !== null && firstXhrUrl) {
      const previousCursor = String(nextCursor);
      if (directCursorMode) {
        await page.waitForTimeout(1200);
        const resumed = await fetchDirectPage(nextCursor).catch(() => null);
        const payload = resumed?.body;
        if (resumed?.status >= 400 || !payload || Number(payload.statusCode ?? payload.status_code ?? 0) !== 0 || !Array.isArray(payload.itemList)) {
          paginationError = resumed?.status === 429
            ? 'TikTok rate limited the saved-cursor request (HTTP 429). Wait before trying again.'
            : 'TikTok rejected a direct continuation from the saved repost cursor.';
          break;
        }
        ingest(payload);
        await ingestQueue;
        if (statusCode !== 0) {
          paginationError = `TikTok returned repost API status ${statusCode}.`;
          break;
        }
        if (nextCursor === null) {
          if (hasMore) paginationError = 'TikTok indicated there are more reposts but did not provide another page cursor.';
          break;
        }
        if (String(nextCursor) === previousCursor && hasMore) {
          paginationError = 'TikTok stopped advancing the repost page cursor before the feed was complete.';
          break;
        }
        continue;
      }
      let response = null;
      for (let attempt = 1; attempt <= 3 && !response; attempt += 1) {
        await page.waitForTimeout(attempt === 1 ? 900 : 1200);
        const nextPageResponse = page.waitForResponse(
          candidate => /\/api\/repost\/item_list/i.test(candidate.url()),
          { timeout: 10_000 }
        ).catch(() => null);
        await page.mouse.wheel(0, 1500 * attempt).catch(() => {});
        if (attempt > 1) {
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
        }
        response = await nextPageResponse;
      }
      if (!response) {
        paginationError = 'TikTok did not load another repost page after three scroll attempts.';
        break;
      }
      if (response.status() >= 400) {
        paginationError = `TikTok rejected a repost page request (HTTP ${response.status()}).`;
        break;
      }
      try {
        ingest(await response.json());
      } catch {
        paginationError = 'TikTok returned a repost page that the browser could not read.';
        break;
      }
      await ingestQueue;
      if (statusCode !== 0) {
        paginationError = `TikTok returned repost API status ${statusCode}.`;
        break;
      }
      if (stopAtKnown()) break;
      if (nextCursor === null) {
        if (hasMore) paginationError = 'TikTok indicated there are more reposts but did not provide another page cursor.';
        break;
      }
      if (String(nextCursor) === previousCursor && hasMore) {
        paginationError = 'TikTok stopped advancing the repost page cursor before the feed was complete.';
        break;
      }
    }

    if (paginationError) {
      return { handle, reposts: [...reposts.values()], complete: false, foundKnown, nextCursor, error: `Could not scan the complete repost history. ${paginationError}` };
    }

    if (!reposts.size) {
      const body = state.body.toLowerCase();
      const error = /audience controls/.test(body)
        ? 'TikTok hides this profile from the anonymous browser.'
        : !clickedTab && !responseCount
          ? 'TikTok did not show a Reposts tab to the headless browser.'
          : statusCode && statusCode !== 0
            ? `TikTok rejected the repost request (code ${statusCode}).`
            : null;
      return { handle, reposts: [], complete: !error && (!hasMore || stopAtKnown()), foundKnown, nextCursor, error };
    }
    return { handle, reposts: [...reposts.values()], complete: !hasMore || stopAtKnown(), foundKnown, nextCursor, error: null };
  } finally {
    await context.close().catch(() => {});
  }
}

async function launchBrowser() {
  const { launch } = await import('cloakbrowser');
  try {
    return await launch({
      headless: true,
      humanize: false,
      timezone: 'America/Los_Angeles',
      locale: 'en-US',
      args: ['--no-sandbox']
    });
  } catch (cause) {
    const error = new Error(`Could not start CloakBrowser: ${cause.message}`);
    error.status = 503;
    throw error;
  }
}

function touchSyncJob() {
  if (syncJob) syncJob.updatedAt = new Date().toISOString();
}

async function runSyncJob(handles) {
  let browser;
  try {
    browser = await launchBrowser();
    for (const handle of handles) {
      const existing = library.accounts[handle] || null;
      const previousReposts = existing?.reposts || [];
      const previousIds = new Set(previousReposts.map(video => video.id));
      const knownIds = existing ? previousReposts.map(video => video.id) : [];
      const resumeUntilId = existing && !existing.complete ? previousReposts.at(-1)?.id || null : null;
      const resumeCursor = existing && !existing.complete ? existing.resumeCursor ?? null : null;
      const accountProgress = syncJob.accounts.find(account => account.handle === handle);
      Object.assign(accountProgress, {
        mode: resumeCursor !== null ? 'resuming from saved page cursor' : resumeUntilId ? 'continuing saved repost history' : knownIds.length ? 'checking for newer reposts' : 'loading full repost history',
        status: 'scanning',
        pages: 0,
        fetched: 0,
        added: 0,
        foundExisting: false,
        foundResumeBoundary: !resumeUntilId,
        error: null
      });
      syncJob.currentHandle = handle;
      syncJob.currentAccount = accountProgress;
      touchSyncJob();

      let result;
      let checkpointWrites = Promise.resolve();
      let lastCheckpointKey = '';
      try {
        result = await scrapeOne(browser, handle, {
          knownIds,
          resumeUntilId,
          resumeCursor,
          onProgress(progress) {
            accountProgress.pages = progress.pages;
            accountProgress.fetched = progress.fetched;
            accountProgress.foundExisting = progress.foundKnown;
            accountProgress.foundResumeBoundary = progress.foundResumeBoundary;
            syncJob.pagesFetched = syncJob.accounts.reduce((sum, item) => sum + item.pages, 0);
            touchSyncJob();

            if (progress.nextCursor === null) return;
            const checkpointKey = `${progress.nextCursor}:${progress.reposts.length}`;
            if (checkpointKey === lastCheckpointKey) return;
            lastCheckpointKey = checkpointKey;
            const merged = new Map();
            for (const video of [...progress.reposts, ...previousReposts]) {
              if (!merged.has(video.id)) merged.set(video.id, video);
            }
            const checkedAt = new Date().toISOString();
            library.accounts[handle] = {
              handle,
              reposts: [...merged.values()],
              complete: false,
              firstLoadedAt: existing?.firstLoadedAt || checkedAt,
              lastCheckedAt: checkedAt,
              lastAddedCount: [...merged.keys()].filter(id => !previousIds.has(id)).length,
              lastError: null,
              resumeCursor: progress.nextCursor
            };
            checkpointWrites = checkpointWrites.then(() => saveLibrary()).catch(error => {
              storageError = error.message;
              console.error(`Could not checkpoint @${handle}: ${error.message}`);
            });
          }
        });
      } catch (error) {
        result = { handle, reposts: [], complete: false, nextCursor: resumeCursor, error: error.message || 'Could not scan this profile.' };
      }
      await checkpointWrites;

      const merged = new Map();
      for (const video of [...result.reposts, ...previousReposts]) {
        if (!merged.has(video.id)) merged.set(video.id, video);
      }
      const addedCount = result.reposts.filter(video => !previousIds.has(video.id)).length;
      const checkedAt = new Date().toISOString();
      const complete = result.error ? Boolean(existing?.complete && result.nextCursor == null) : Boolean(result.complete);
      library.accounts[handle] = {
        handle,
        reposts: [...merged.values()],
        complete,
        firstLoadedAt: existing?.firstLoadedAt || checkedAt,
        lastCheckedAt: checkedAt,
        lastAddedCount: addedCount,
        lastError: result.error || null,
        resumeCursor: complete ? null : result.nextCursor ?? existing?.resumeCursor ?? null
      };
      accountProgress.added = addedCount;
      accountProgress.status = result.error ? 'error' : result.reposts.length === 0 && previousReposts.length === 0 ? 'no_reposts' : 'complete';
      accountProgress.error = result.error || null;
      syncJob.completedAccounts += 1;
      syncJob.lastCompletedHandle = handle;
      syncJob.currentAccount = accountProgress;
      await saveLibrary();
      touchSyncJob();
    }
    syncJob.status = syncJob.accounts.some(account => account.status === 'error') ? 'completed_with_errors' : 'completed';
    syncJob.currentHandle = null;
    syncJob.finishedAt = new Date().toISOString();
    lastSyncSummary = { status: syncJob.status, finishedAt: syncJob.finishedAt, jobId: syncJob.id };
  } catch (error) {
    syncJob.status = 'failed';
    syncJob.error = error.message || 'Sync failed.';
    syncJob.finishedAt = new Date().toISOString();
  } finally {
    await browser?.close().catch(() => {});
    touchSyncJob();
  }
}

function beginSync(handles) {
  if (syncJob?.status === 'running') {
    const error = new Error('A repost sync is already running.');
    error.status = 409;
    throw error;
  }
  syncJob = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    status: 'running',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    finishedAt: null,
    requestedAccounts: handles,
    totalAccounts: handles.length,
    completedAccounts: 0,
    pagesFetched: 0,
    currentHandle: null,
    lastCompletedHandle: null,
    currentAccount: null,
    accounts: handles.map(handle => ({ handle, status: 'queued', pages: 0, fetched: 0, added: 0, error: null })),
    error: null
  };
  void runSyncJob(handles);
  return syncJob;
}

async function serveStatic(req, res, url) {
  let pathname;
  try { pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname); }
  catch {
    res.writeHead(400);
    return res.end('Bad request');
  }
  const filePath = path.resolve(PUBLIC_DIR, `.${pathname}`);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  try {
    const content = await fs.promises.readFile(filePath);
    res.writeHead(200, {
      'content-type': mimeTypes[path.extname(filePath)] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff'
    });
    res.end(content);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/api/health') {
    await libraryReady;
    return json(res, storageError ? 503 : 200, {
      status: storageError ? 'degraded' : 'ok',
      port: PORT,
      storage: { file: path.relative(__dirname, LIBRARY_PATH), accounts: Object.keys(library.accounts).length, reposts: totalStoredReposts(), error: storageError },
      sync: syncJob ? { id: syncJob.id, status: syncJob.status, updatedAt: syncJob.updatedAt } : null
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/accounts') {
    await libraryReady;
    return json(res, storageError ? 503 : 200, { accounts: accountSummaries() });
  }
  if (req.method === 'GET' && url.pathname === '/api/sync/status') {
    await libraryReady;
    return json(res, 200, { job: syncJob, lastSync: lastSyncSummary });
  }
  const accountPath = url.pathname.match(/^\/api\/accounts\/([^/]+)$/);
  if (accountPath && req.method === 'GET') {
    await libraryReady;
    let handle;
    try { handle = decodeURIComponent(accountPath[1]); }
    catch { return json(res, 400, { error: 'Invalid username.' }); }
    const account = library.accounts[handle.toLowerCase()];
    if (!account) return json(res, 404, { error: `@${handle} is not in the local library.` });
    return json(res, 200, { account });
  }
  if (accountPath && req.method === 'DELETE') {
    await libraryReady;
    if (syncJob?.status === 'running') return json(res, 409, { error: 'Wait for the active sync to finish before removing an account.' });
    let handle;
    try { handle = decodeURIComponent(accountPath[1]).toLowerCase(); }
    catch { return json(res, 400, { error: 'Invalid username.' }); }
    if (!library.accounts[handle]) return json(res, 404, { error: `@${handle} is not in the local library.` });
    delete library.accounts[handle];
    try { await saveLibrary(); }
    catch (error) { return json(res, 500, { error: `Could not save the local library: ${error.message}` }); }
    return json(res, 200, { removed: handle });
  }
  if (req.method === 'POST' && url.pathname === '/api/sync') {
    try {
      await libraryReady;
      if (storageError) return json(res, 503, { error: `Local library is unavailable: ${storageError}` });
      const body = await readBody(req);
      const handles = normalizeHandles(body.handles, 1, 500).map(handle => handle.toLowerCase());
      const job = beginSync(handles);
      return json(res, 202, { jobId: job.id, statusUrl: '/api/sync/status' });
    } catch (error) {
      return json(res, error.status || 400, { error: error.message || 'Could not load reposts.' });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/game/reposts') {
    try {
      await libraryReady;
      if (storageError) return json(res, 503, { error: `Local library is unavailable: ${storageError}` });
      const body = await readBody(req);
      const handles = normalizeHandles(body.handles);
      const missing = handles.filter(handle => !library.accounts[handle.toLowerCase()]);
      if (missing.length) return json(res, 422, { error: `Load these accounts into the local library first: ${missing.map(handle => `@${handle}`).join(', ')}.` });
      const empty = handles.filter(handle => library.accounts[handle.toLowerCase()].reposts.length === 0);
      if (empty.length) return json(res, 422, { error: `Can’t start until every player has reposts. No reposts found for ${empty.map(handle => `@${handle}`).join(', ')}.` });
      const incomplete = handles.filter(handle => !library.accounts[handle.toLowerCase()].complete);
      if (incomplete.length) return json(res, 422, { error: `Finish the initial scan before playing with ${incomplete.map(handle => `@${handle}`).join(', ')}.` });
      const people = handles.map(handle => {
        const account = library.accounts[handle.toLowerCase()];
        return { handle: account.handle, reposts: account.reposts };
      });
      return json(res, 200, { people, total: people.reduce((sum, person) => sum + person.reposts.length, 0) });
    } catch (error) {
      return json(res, error.status || 400, { error: error.message || 'Could not load saved reposts.' });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/reposts') {
    return json(res, 409, { error: 'Reposts are now loaded and updated from the local library. Visit /library.html.' });
  }
  if (req.method !== 'GET') {
    res.writeHead(405, { allow: 'GET, POST, DELETE' });
    return res.end('Method not allowed');
  }
  return serveStatic(req, res, url);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`who_liked is up at http://localhost:${PORT}`);
});

server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? `Port ${PORT} is already in use.` : error);
  process.exitCode = 1;
});
