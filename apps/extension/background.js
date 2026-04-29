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

// Tell content script to stop and clear its interval.
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
        await setState({ recording: false, tabId: null, domain: null });
        sendResponse({ ok: true });
        break;
      }

      case 'recording_started': {
        // Content script tells us the domain it's running on.
        await setState({ domain: msg.domain ?? null });
        console.log('[Aegis] content script active on', msg.domain);
        sendResponse({ ok: true });
        break;
      }

      case 'heartbeat': {
        const state = await getState();
        if (state.recording) {
          await setState({ eventCount: (state.eventCount ?? 0) + 1 });
        }
        sendResponse({ ok: true });
        break;
      }

      default:
        sendResponse({ ok: false, error: 'unknown action' });
    }
  })();

  // Keep the message channel open for the async response.
  return true;
});
