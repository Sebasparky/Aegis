function defaultState() {
  return { recording: false, tabId: null, domain: null, eventCount: 0 };
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
          fetch(`http://localhost:4000/api/route-runs/${msg.run_id}/complete`, { method: 'POST' })
            .catch(() => {});
        }
        sendResponse({ ok: true });
        break;
      }

      case 'replay_failed': {
        await chrome.storage.session.set({ aegisReplayStatus: msg });
        if (msg.run_id) {
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
        let route;
        try {
          const res = await fetch(`http://localhost:4000/api/routes/${run.route_id}`);
          const body = await res.json();
          if (!res.ok || !body.ok) {
            sendResponse({ ok: false, error: body?.error?.message ?? 'Route not found.' });
            break;
          }
          route = body.data;
        } catch (_) {
          sendResponse({ ok: false, error: 'Aegis API unavailable at localhost:4000.' });
          break;
        }

        try {
          const tab = await chrome.tabs.get(runTabId);
          const tabHostname = new URL(tab.url).hostname;
          if (route.domain !== tabHostname) {
            sendResponse({ ok: false, error: `Route domain "${route.domain}" does not match current tab "${tabHostname}".` });
            break;
          }
        } catch (err) {
          sendResponse({ ok: false, error: 'Could not read tab URL: ' + err.message });
          break;
        }

        try {
          await chrome.scripting.executeScript({ target: { tabId: runTabId }, files: ['replay.js'] });
        } catch (err) {
          sendResponse({ ok: false, error: 'Failed to inject replay script: ' + err.message });
          break;
        }

        try {
          await chrome.tabs.sendMessage(runTabId, {
            action: 'start_replay',
            route,
            variables: run.variables ?? {},
            run_id: run.run_id,
          });
        } catch (err) {
          sendResponse({ ok: false, error: 'Failed to start replay: ' + err.message });
          break;
        }

        sendResponse({ ok: true });
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
