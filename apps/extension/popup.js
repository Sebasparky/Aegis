const dot          = document.getElementById('dot');
const statusText   = document.getElementById('status-text');
const domainText   = document.getElementById('domain-text');
const countEl      = document.getElementById('count');
const btn          = document.getElementById('toggle-btn');
const copyBtn      = document.getElementById('copy-btn');
const submitBtn    = document.getElementById('submit-btn');
const submitResult = document.getElementById('submit-result');
const eventList    = document.getElementById('event-list');

function defaultState() {
  return { recording: false, tabId: null, domain: null, eventCount: 0 };
}

function applyState(state) {
  const { recording, domain, eventCount } = state;
  dot.className          = 'dot' + (recording ? ' recording' : '');
  statusText.textContent = recording ? 'Recording' : 'Idle';
  domainText.textContent = recording && domain ? domain : (domain || '');
  countEl.textContent    = eventCount ?? 0;
  btn.className          = recording ? 'recording' : 'idle';
  btn.textContent        = recording ? 'Stop Recording' : 'Start Recording';
}

// ── Event list helpers ────────────────────────────────────────────────────────

function getBestTarget(ev) {
  return ev.aria_label
    || ev.label_text
    || ev.visible_text
    || ev.input_name
    || ev.input_id
    || ev.locators?.[0]?.name
    || ev.locators?.[0]?.value
    || ev.element_role
    || '—';
}

function getLocatorSummary(ev) {
  const loc = ev.locators?.[0];
  if (!loc) return '';
  const val = loc.name || loc.value || '';
  return loc.type + (val ? ':' + val.slice(0, 28) : '');
}

function renderEvents(events) {
  const show = events.length > 0 ? 'block' : 'none';
  copyBtn.style.display   = show;
  submitBtn.style.display = show;

  if (events.length === 0) {
    eventList.innerHTML = '<p class="empty-msg">No page events captured yet.</p>';
    return;
  }

  eventList.innerHTML = '';
  events.forEach((ev) => {
    const type    = ev.type || 'event';
    const target  = getBestTarget(ev);
    const locator = getLocatorSummary(ev);
    const value   = ev.raw_value ? ev.raw_value.slice(0, 22) : '';

    const row = document.createElement('div');
    row.className = 'event-row';
    row.innerHTML =
      '<span class="badge ' + escHtml(type) + '">' + escHtml(type) + '</span>' +
      '<span class="ev-target" title="' + escHtml(target) + '">' + escHtml(target) + '</span>' +
      '<span class="ev-meta">' + escHtml(locator) +
        (value ? '<span class="ev-value">' + escHtml(value) + '</span>' : '') +
      '</span>';

    eventList.appendChild(row);
  });
}

// Minimal XSS guard — popup is extension-owned, but page content flows through here.
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Storage reads ─────────────────────────────────────────────────────────────

chrome.storage.session.get(['aegisRecorder', 'aegisRecorderEvents'], (result) => {
  applyState(result.aegisRecorder ?? defaultState());
  renderEvents(result.aegisRecorderEvents ?? []);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session') return;
  if (changes.aegisRecorder)       applyState(changes.aegisRecorder.newValue ?? defaultState());
  if (changes.aegisRecorderEvents) renderEvents(changes.aegisRecorderEvents.newValue ?? []);
});

// ── Button handlers ───────────────────────────────────────────────────────────

btn.addEventListener('click', async () => {
  const result = await chrome.storage.session.get('aegisRecorder');
  const state  = result.aegisRecorder ?? defaultState();

  if (state.recording) {
    chrome.runtime.sendMessage({ action: 'stop' });
  } else {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    chrome.runtime.sendMessage({ action: 'start', tabId: tab.id });
  }
});

submitBtn.addEventListener('click', async () => {
  submitBtn.disabled = true;
  submitBtn.textContent = 'Submitting…';
  submitResult.textContent = '';
  submitResult.className = '';

  const resp = await chrome.runtime.sendMessage({ action: 'submit' });

  submitBtn.disabled = false;
  submitBtn.textContent = 'Submit to Aegis';

  if (resp?.ok) {
    submitResult.textContent = '✓ Saved as ' + resp.workflow_name + ' (' + resp.route_id + ')';
    submitResult.className = 'result-ok';
  } else {
    submitResult.textContent = resp?.error ?? 'Unknown error.';
    submitResult.className = 'result-err';
  }
});

copyBtn.addEventListener('click', async () => {
  const result = await chrome.storage.session.get(['aegisRecorder', 'aegisRecorderEvents']);
  const state  = result.aegisRecorder ?? defaultState();
  const events = result.aegisRecorderEvents ?? [];
  // Domain is preserved after stop; fall back to the first event URL if somehow missing.
  let domain = state.domain ?? '';
  if (!domain && events.length > 0) {
    try { domain = new URL(events[0].url).hostname; } catch (_) {}
  }
  const payload = {
    workflow_name: 'External Recording',
    domain,
    events,
  };
  try {
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    copyBtn.textContent = 'Copied!';
    setTimeout(() => { copyBtn.textContent = 'Copy JSON'; }, 2000);
  } catch (_) {
    copyBtn.textContent = 'Copy failed';
    setTimeout(() => { copyBtn.textContent = 'Copy JSON'; }, 2000);
  }
});
