function defaultState() {
  return { recording: false, tabId: null, domain: null, eventCount: 0 };
}

function getHostname(url) {
  try { return new URL(url).hostname; } catch (_) { return null; }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Returns null on success, an error string on failure.
async function verifyTabOutcome(tabId, domain, variables) {
  // Demo login: verify the page navigated to /demo-login/success.
  // Uses URL polling — works with Next.js client-side navigation where replay_done
  // fires before the URL update propagates to the background context.
  // Bails out immediately if the URL is not on a /demo-login path, so other
  // localhost routes (e.g. the demo banking workflow at localhost:3001) pass through.
  if (domain === 'localhost') {
    const deadline = Date.now() + 6000;
    await sleep(200);
    while (Date.now() < deadline) {
      try {
        const tab = await chrome.tabs.get(tabId);
        const url = tab.url ?? '';
        if (url.includes('/demo-login/success')) return null;
        if (!url.includes('/demo-login')) return null; // not a login flow, pass through
      } catch (_) {
        return 'outcome verification failed: tab not accessible';
      }
      await sleep(200);
    }
    try {
      const tab = await chrome.tabs.get(tabId);
      return `outcome verification failed: expected /demo-login/success, current URL: ${tab?.url ?? 'unknown'}`;
    } catch (_) {
      return 'outcome verification failed: tab not accessible after timeout';
    }
  }

  if (domain !== 'en.wikipedia.org' || !variables?.query) return null;

  const rawQuery   = variables.query.trim();
  const normalized = rawQuery.toLowerCase().replace(/\s+/g, ' ');
  const deadline   = Date.now() + 8000;

  await sleep(300); // brief pause to let navigation begin

  while (Date.now() < deadline) {
    try {
      const tab = await chrome.tabs.get(tabId);
      const url  = tab.url ?? '';

      // Check URL as soon as navigation starts — tab.url is set even during 'loading'.
      try {
        const parsed = new URL(url);
        if (parsed.hostname === 'en.wikipedia.org') {
          if (parsed.pathname.startsWith('/wiki/')) {
            // Article URL: decode slug, normalize spaces/underscores, compare exactly.
            const slug = decodeURIComponent(parsed.pathname.slice(6))
              .replace(/_/g, ' ')
              .toLowerCase()
              .replace(/\s+/g, ' ')
              .trim();
            if (slug === normalized) return null;
          } else if (parsed.pathname === '/w/index.php') {
            // Search results URL: empty search param is a definitive failure.
            const searchParam = parsed.searchParams.get('search') ?? '';
            if (!searchParam.trim()) {
              return `outcome verification failed: form submitted with empty search (url=${url})`;
            }
            const searchNorm = searchParam.toLowerCase().replace(/\s+/g, ' ').trim();
            if (searchNorm === normalized || searchNorm.includes(normalized)) return null;
          }
        }
      } catch (_) {
        // Unparseable URL — keep polling.
      }

      // Secondary check via tab title once page is fully loaded.
      if (tab.status === 'complete') {
        const titleCore = (tab.title ?? '')
          .replace(/ [-–—] Wikipedia$/, '')
          .toLowerCase()
          .replace(/\s+/g, ' ')
          .trim();
        if (titleCore === normalized || titleCore.includes(normalized)) return null;
      }
    } catch (_) {
      return `outcome verification failed: tab not accessible after navigating for "${rawQuery}"`;
    }
    await sleep(150);
  }

  try {
    const tab = await chrome.tabs.get(tabId);
    return `outcome verification failed: expected Wikipedia result for "${rawQuery}", url=${tab.url ?? 'unknown'}, title=${tab.title ?? 'unknown'}`;
  } catch (_) {
    return `outcome verification failed: expected Wikipedia result for "${rawQuery}"`;
  }
}

// Reads the stored run context as a mutex: the first caller to remove the key wins.
// Subsequent callers find nothing and return, preventing double-complete.
async function finishRunWithOutcomeVerification(runId, tabId, domain, variables) {
  const ctxResult = await chrome.storage.session.get(`aegisRunCtx_${runId}`);
  if (!ctxResult[`aegisRunCtx_${runId}`]) return;
  await chrome.storage.session.remove(`aegisRunCtx_${runId}`);

  const error = await verifyTabOutcome(tabId, domain, variables);

  if (error) {
    fetch(`http://localhost:4000/api/route-runs/${runId}/fail`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error }),
    }).catch(() => {});
  } else {
    fetch(`http://localhost:4000/api/route-runs/${runId}/complete`, { method: 'POST' }).catch(() => {});
  }
}

async function getAutoStartedRunIds() {
  const stored = await chrome.storage.session.get('aegisAutoStartedRunIds');
  return new Set(stored.aegisAutoStartedRunIds ?? []);
}

async function markAutoStarted(runId) {
  const ids = await getAutoStartedRunIds();
  ids.add(runId);
  await chrome.storage.session.set({ aegisAutoStartedRunIds: [...ids] });
}

async function getState() {
  const result = await chrome.storage.session.get('aegisRecorder');
  return result.aegisRecorder ?? defaultState();
}

async function setState(patch) {
  const current = await getState();
  await chrome.storage.session.set({ aegisRecorder: { ...current, ...patch } });
}

// Tell content script to stop and clear its listeners.
async function notifyContentStop(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { action: 'stop_recording' });
  } catch (_) {
    // Tab may have navigated away — safe to ignore.
  }
}

// ─── Shared execution helper ─────────────────────────────────────────────────

async function executeRunOnTab(run, tabId) {
  let route;
  try {
    const res = await fetch(`http://localhost:4000/api/routes/${run.route_id}`);
    const body = await res.json();
    if (!res.ok || !body.ok) return { ok: false, error: body?.error?.message ?? 'Route not found.' };
    route = body.data;
  } catch (_) {
    return { ok: false, error: 'Aegis API unavailable at localhost:4000.' };
  }

  try {
    const tab = await chrome.tabs.get(tabId);
    if (!doesTabMatchRoute(tab.url, route)) {
      const tabParsed = new URL(tab.url);
      const expected = route.url_match?.path_prefix
        ? `${route.url_match.hostname ?? route.domain}${route.url_match.path_prefix}`
        : route.domain;
      return { ok: false, error: `Route requires ${expected} but current tab is ${tabParsed.hostname}${tabParsed.pathname}.` };
    }
  } catch (err) {
    return { ok: false, error: 'Could not read tab URL: ' + err.message };
  }

  try {
    const startRes = await fetch(`http://localhost:4000/api/route-runs/${run.run_id}/start`, { method: 'POST' });
    const startBody = await startRes.json();
    if (!startRes.ok || !startBody.ok) {
      return { ok: false, error: startBody?.error?.message ?? 'Failed to start run.' };
    }
  } catch (_) {
    return { ok: false, error: 'Aegis API unavailable at localhost:4000.' };
  }

  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['replay.js'] });
  } catch (err) {
    return { ok: false, error: 'Failed to inject replay script: ' + err.message };
  }

  try {
    await chrome.tabs.sendMessage(tabId, {
      action: 'start_replay',
      route,
      variables: run.variables ?? {},
      run_id: run.run_id,
    });
  } catch (err) {
    return { ok: false, error: 'Failed to start replay: ' + err.message };
  }

  if (run.run_id) {
    await chrome.storage.session.set({
      [`aegisRunCtx_${run.run_id}`]: { tabId, domain: route.domain, variables: run.variables ?? {} },
    });

    // For navigation-based routes (Wikipedia search), replay.js is destroyed by the
    // full-page navigation before it can send replay_done. Start a background watcher
    // that independently verifies the tab outcome and completes/fails the run.
    if (route.domain === 'en.wikipedia.org' && run.variables?.query) {
      setTimeout(() => {
        finishRunWithOutcomeVerification(run.run_id, tabId, route.domain, run.variables ?? {});
      }, 500);
    }
  }

  return { ok: true };
}

// ─── Route URL matching ───────────────────────────────────────────────────────

// Returns true if tabUrl satisfies the route's domain + optional path constraint.
// route may be a full AegisRoute or the route_summary shape from GET /api/route-runs.
function doesTabMatchRoute(tabUrl, route) {
  try {
    const u = new URL(tabUrl);
    const expectedHostname = route.url_match?.hostname ?? route.domain;
    if (u.hostname !== expectedHostname) return false;
    if (route.url_match?.path_prefix) return u.pathname.startsWith(route.url_match.path_prefix);
    return true;
  } catch (_) {
    return false;
  }
}

// ─── Background auto-run ─────────────────────────────────────────────────────

function isEligibleForBackgroundAutoRun(r, startedIds) {
  if (r.status !== 'pending') return false;
  if (startedIds.has(r.run_id)) return false;
  if (r.skill_summary?.risk_level === 'low') return true;
  if (r.approved_at && r.approved_permissions?.length > 0) return true;
  return false;
}

async function syncAutoRunAlarm() {
  try {
    const { aegisAutoRunAllowed } = await chrome.storage.local.get('aegisAutoRunAllowed');
    if (aegisAutoRunAllowed) {
      // ~10 second polling interval to catch approvals on already-active tabs
      chrome.alarms.create('aegisAutoRunPoll', { periodInMinutes: 10 / 60 });
    } else {
      chrome.alarms.clear('aegisAutoRunPoll');
    }
  } catch (_) {}
}

async function maybeAutoRunForTab(tab) {
  if (!tab?.id || !tab?.url) return;
  if (!tab.url.startsWith('http://') && !tab.url.startsWith('https://')) return;

  const localResult = await chrome.storage.local.get('aegisAutoRunAllowed');
  if (!localResult.aegisAutoRunAllowed) return;

  const hostname = getHostname(tab.url);
  if (!hostname) return;

  let runs;
  try {
    const res = await fetch(
      `http://localhost:4000/api/route-runs?domain=${encodeURIComponent(hostname)}&status=pending`
    );
    const json = await res.json();
    if (!json.ok) return;
    runs = json.data ?? [];
  } catch (_) {
    return;
  }

  const startedIds = await getAutoStartedRunIds();

  const eligible = runs
    .filter(r => isEligibleForBackgroundAutoRun(r, startedIds))
    .filter(r => doesTabMatchRoute(tab.url, r.route_summary ?? { domain: r.domain }));

  if (eligible.length !== 1) return;

  const run = eligible[0];
  await markAutoStarted(run.run_id);
  await executeRunOnTab(run, tab.id);
}

// Poll up to timeoutMs for a tab to finish loading and match the route's url_match/domain.
async function waitForTabToMatchRoute(tabId, route, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete' && doesTabMatchRoute(tab.url, route)) return true;
    } catch (_) {
      return false; // tab was closed
    }
    await sleep(300);
  }
  return false;
}

// For approved sensitive runs whose route has a start_url: if no matching tab exists,
// open one and execute there. If a matching tab already exists, execute on it directly.
// This completes the approval → execution loop without manual navigation.
async function maybeAutoLaunchApprovedRun() {
  const { aegisAutoRunAllowed } = await chrome.storage.local.get('aegisAutoRunAllowed');
  if (!aegisAutoRunAllowed) return;

  let runs;
  try {
    const res = await fetch('http://localhost:4000/api/route-runs?status=pending');
    const json = await res.json();
    if (!json.ok) return;
    runs = json.data ?? [];
  } catch (_) {
    return;
  }

  const startedIds = await getAutoStartedRunIds();

  // Only approved runs that have a start_url — low-risk runs are already handled by maybeAutoRunForTab.
  const eligible = runs.filter(r =>
    isEligibleForBackgroundAutoRun(r, startedIds) &&
    r.approved_at &&
    r.route_summary?.start_url
  );

  // Safety: never open multiple tabs or run multiple credentials at once.
  if (eligible.length !== 1) return;

  const run = eligible[0];
  const routeSummary = run.route_summary;

  // Check for an existing tab at exactly start_url (not a subpath like /demo-login/success).
  // Using doesTabMatchRoute here would reuse a previous run's outcome page, skipping credential fill.
  const allTabs = await chrome.tabs.query({});
  const matchingTab = allTabs.find(tab => {
    if (!tab.url || !routeSummary?.start_url) return false;
    try {
      const tabU = new URL(tab.url);
      const startU = new URL(routeSummary.start_url);
      return tabU.hostname === startU.hostname &&
             tabU.port === startU.port &&
             tabU.pathname === startU.pathname;
    } catch (_) { return false; }
  });

  if (matchingTab?.id) {
    // Existing matching tab — use it directly.
    await markAutoStarted(run.run_id);
    await executeRunOnTab(run, matchingTab.id);
    return;
  }

  // No matching tab — create one at start_url.
  // Mark as started BEFORE creating the tab so the onUpdated listener won't double-execute.
  await markAutoStarted(run.run_id);

  let newTab;
  try {
    newTab = await chrome.tabs.create({ url: routeSummary.start_url, active: true });
  } catch (_) {
    return;
  }
  if (!newTab?.id) return;

  const matched = await waitForTabToMatchRoute(newTab.id, routeSummary, 5000);
  if (!matched) return;

  await executeRunOnTab(run, newTab.id);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg.action) {

      case 'start': {
        const { tabId } = msg;
        // Domain will be supplied by the content script via "recording_started".
        await setState({ recording: true, tabId, domain: null, eventCount: 0 });
        // Clear any events from a previous recording.
        await chrome.storage.session.set({ aegisRecorderEvents: [] });

        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            files: ['content.js'],
          });
        } catch (err) {
          console.warn('[Aegis] content script injection failed:', err.message);
          await setState({ recording: false, tabId: null, domain: null, eventCount: 0 });
        }

        sendResponse({ ok: true });
        break;
      }

      case 'stop': {
        const state = await getState();
        if (state.tabId) await notifyContentStop(state.tabId);
        // Preserve domain so popup Copy JSON works after stop.
        await setState({ recording: false, tabId: null });

        // Log buffered event count for verification (M3 will POST these).
        const stored = await chrome.storage.session.get('aegisRecorderEvents');
        const events = stored.aegisRecorderEvents ?? [];
        console.log('[Aegis] recording stopped —', events.length, 'event(s) buffered');

        sendResponse({ ok: true });
        break;
      }

      case 'recording_started': {
        await setState({ domain: msg.domain ?? null });
        console.log('[Aegis] content script active on', msg.domain);
        sendResponse({ ok: true });
        break;
      }

      case 'event': {
        const state = await getState();
        if (!state.recording) {
          sendResponse({ ok: false });
          break;
        }
        const stored = await chrome.storage.session.get('aegisRecorderEvents');
        const events = stored.aegisRecorderEvents ?? [];

        // Coalesce consecutive fill events for the same field: replace the most
        // recent matching fill instead of appending, so only the final typed value
        // is kept (avoids "M" → "Mi" → "Michigan" duplicates).
        if (msg.event.type === 'fill') {
          const fieldKey = msg.event.input_name || msg.event.input_id
            || (msg.event.locators?.[0]
              ? msg.event.locators[0].type + ':' + (msg.event.locators[0].name ?? msg.event.locators[0].value ?? '')
              : null);

          if (fieldKey) {
            let replaceIdx = -1;
            for (let i = events.length - 1; i >= 0; i--) {
              if (events[i].type !== 'fill') continue;
              const ek = events[i].input_name || events[i].input_id
                || (events[i].locators?.[0]
                  ? events[i].locators[0].type + ':' + (events[i].locators[0].name ?? events[i].locators[0].value ?? '')
                  : null);
              if (ek === fieldKey) { replaceIdx = i; break; }
            }
            if (replaceIdx !== -1) {
              events[replaceIdx] = msg.event;
              await chrome.storage.session.set({ aegisRecorderEvents: events });
              // Count unchanged — just re-render with updated value.
              console.log('[Aegis] fill coalesced:', msg.event.label_text ?? fieldKey);
              sendResponse({ ok: true });
              break;
            }
          }
        }

        events.push(msg.event);
        await chrome.storage.session.set({ aegisRecorderEvents: events });
        await setState({ eventCount: events.length });
        console.log('[Aegis] event captured:', msg.event.type, msg.event.element_role, msg.event.label_text ?? '');
        sendResponse({ ok: true });
        break;
      }

      case 'submit': {
        const state = await getState();
        const stored = await chrome.storage.session.get('aegisRecorderEvents');
        const events = stored.aegisRecorderEvents ?? [];

        if (events.length === 0) {
          sendResponse({ ok: false, error: 'No events recorded.' });
          break;
        }

        let domain = state.domain ?? '';
        if (!domain && events.length > 0) {
          try { domain = new URL(events[0].url).hostname; } catch (_) {}
        }

        const workflow_name = domain.includes('wikipedia.org')
          ? 'Wikipedia Search'
          : 'External Recording';

        let res;
        try {
          res = await fetch('http://localhost:4000/api/routes/record', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workflow_name, domain, events }),
          });
        } catch (_) {
          sendResponse({ ok: false, error: 'Aegis API unavailable at localhost:4000.' });
          break;
        }

        let body;
        try { body = await res.json(); } catch (_) { body = {}; }

        if (!res.ok) {
          sendResponse({ ok: false, error: body?.error?.message ?? 'Submission failed.' });
          break;
        }

        sendResponse({ ok: true, route_id: body.data.route_id, workflow_name: body.data.workflow_name });
        break;
      }

      case 'preview': {
        const { tabId, routeId } = msg;

        let route;
        try {
          const res = await fetch(`http://localhost:4000/api/routes/${routeId}`);
          const body = await res.json();
          if (!res.ok || !body.ok) {
            sendResponse({ ok: false, error: body?.error?.message ?? 'Failed to fetch route.' });
            break;
          }
          route = body.data;
        } catch (_) {
          sendResponse({ ok: false, error: 'Aegis API unavailable at localhost:4000.' });
          break;
        }

        if (route.domain !== 'en.wikipedia.org') {
          sendResponse({ ok: false, error: `Route domain is "${route.domain}", not en.wikipedia.org.` });
          break;
        }

        try {
          await chrome.scripting.executeScript({ target: { tabId }, files: ['replay.js'] });
        } catch (err) {
          sendResponse({ ok: false, error: 'Failed to inject replay script: ' + err.message });
          break;
        }

        try {
          await chrome.tabs.sendMessage(tabId, { action: 'start_replay', route });
        } catch (err) {
          sendResponse({ ok: false, error: 'Failed to start replay: ' + err.message });
          break;
        }

        sendResponse({ ok: true });
        break;
      }

      case 'replay_progress': {
        await chrome.storage.session.set({ aegisReplayStatus: msg });
        sendResponse({ ok: true });
        break;
      }

      case 'replay_done': {
        await chrome.storage.session.set({ aegisReplayStatus: msg });
        if (msg.run_id) {
          const ctxResult = await chrome.storage.session.get(`aegisRunCtx_${msg.run_id}`);
          const ctx = ctxResult[`aegisRunCtx_${msg.run_id}`] ?? null;
          if (!ctx) break; // navigation watcher already consumed the context and handled this run
          await chrome.storage.session.remove(`aegisRunCtx_${msg.run_id}`);

          const outcomeError = await verifyTabOutcome(ctx.tabId, ctx.domain, ctx.variables);

          if (outcomeError) {
            fetch(`http://localhost:4000/api/route-runs/${msg.run_id}/fail`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ error: outcomeError }),
            }).catch(() => {});
          } else {
            fetch(`http://localhost:4000/api/route-runs/${msg.run_id}/complete`, { method: 'POST' })
              .catch(() => {});
          }
        }
        sendResponse({ ok: true });
        break;
      }

      case 'replay_failed': {
        await chrome.storage.session.set({ aegisReplayStatus: msg });
        if (msg.run_id) {
          const ctxResult = await chrome.storage.session.get(`aegisRunCtx_${msg.run_id}`);
          if (!ctxResult[`aegisRunCtx_${msg.run_id}`]) break; // watcher already handled this run
          await chrome.storage.session.remove(`aegisRunCtx_${msg.run_id}`);
          fetch(`http://localhost:4000/api/route-runs/${msg.run_id}/fail`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: msg.error ?? 'Replay failed' }),
          }).catch(() => {});
        }
        sendResponse({ ok: true });
        break;
      }

      case 'list_pending_runs_for_domain': {
        const { domain: runDomain } = msg;
        try {
          const res = await fetch(
            `http://localhost:4000/api/route-runs?domain=${encodeURIComponent(runDomain)}&status=pending`
          );
          const json = await res.json();
          if (json.ok) {
            sendResponse({ ok: true, runs: json.data });
          } else {
            sendResponse({ ok: false, error: json.error?.message ?? 'API error' });
          }
        } catch (_) {
          sendResponse({ ok: false, error: 'Aegis API unavailable at localhost:4000.' });
        }
        break;
      }

      case 'start_route_run': {
        const { run, tabId: runTabId } = msg;
        const result = await executeRunOnTab(run, runTabId);
        sendResponse(result);
        break;
      }

      case 'list_installed_skills_for_domain': {
        const { domain } = msg;
        try {
          const res = await fetch(
            `http://localhost:4000/api/skills?domain=${encodeURIComponent(domain)}&installed=true`
          );
          const json = await res.json();
          if (json.ok) {
            sendResponse({ ok: true, skills: json.data });
          } else {
            sendResponse({ ok: false, error: json.error?.message ?? 'API error' });
          }
        } catch (_) {
          sendResponse({ ok: false, error: 'Aegis API unavailable at localhost:4000.' });
        }
        break;
      }

      default:
        sendResponse({ ok: false, error: 'unknown action' });
    }
  })();

  // Keep the message channel open for the async response.
  return true;
});

// ─── Background auto-run listeners ──────────────────────────────────────────

// Sync alarm on service worker startup
syncAutoRunAlarm();

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'aegisAutoRunPoll') return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) await maybeAutoRunForTab(tab);
    await maybeAutoLaunchApprovedRun();
  } catch (_) {}
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await maybeAutoRunForTab(tab);
  } catch (_) {}
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  await sleep(750);
  try {
    const freshTab = await chrome.tabs.get(tabId);
    await maybeAutoRunForTab(freshTab);
  } catch (_) {}
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  if (!('aegisAutoRunAllowed' in changes)) return;
  await syncAutoRunAlarm();
  if (!changes.aegisAutoRunAllowed?.newValue) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) await maybeAutoRunForTab(tab);
  } catch (_) {}
});
