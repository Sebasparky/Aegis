const dot        = document.getElementById('dot');
const statusText = document.getElementById('status-text');
const domainText = document.getElementById('domain-text');
const countEl    = document.getElementById('count');
const btn        = document.getElementById('toggle-btn');

function applyState(state) {
  const { recording, domain, eventCount } = state;

  dot.className        = 'dot' + (recording ? ' recording' : '');
  statusText.textContent = recording ? 'Recording' : 'Idle';
  domainText.textContent = recording && domain ? domain : '';
  countEl.textContent    = eventCount ?? 0;
  btn.className          = recording ? 'recording' : 'idle';
  btn.textContent        = recording ? 'Stop Recording' : 'Start Recording';
}

function defaultState() {
  return { recording: false, tabId: null, domain: null, eventCount: 0 };
}

// Load initial state from storage.
chrome.storage.session.get('aegisRecorder', (result) => {
  applyState(result.aegisRecorder ?? defaultState());
});

// Keep popup live while open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.aegisRecorder) {
    applyState(changes.aegisRecorder.newValue ?? defaultState());
  }
});

btn.addEventListener('click', async () => {
  const result = await chrome.storage.session.get('aegisRecorder');
  const state  = result.aegisRecorder ?? defaultState();

  if (state.recording) {
    chrome.runtime.sendMessage({ action: 'stop' });
  } else {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    // Domain is supplied by the content script on injection, not read here.
    // tab.url requires the `tabs` permission which we intentionally omit.
    chrome.runtime.sendMessage({ action: 'start', tabId: tab.id });
  }
});
