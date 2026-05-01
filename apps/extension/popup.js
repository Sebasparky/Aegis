const dot            = document.getElementById('dot');
const statusText     = document.getElementById('status-text');
const domainText     = document.getElementById('domain-text');
const countEl        = document.getElementById('count');
const btn            = document.getElementById('toggle-btn');
const copyBtn        = document.getElementById('copy-btn');
const submitBtn      = document.getElementById('submit-btn');
const submitResult   = document.getElementById('submit-result');
const previewSection = document.getElementById('preview-section');
const routeIdInput   = document.getElementById('route-id-input');
const previewBtn     = document.getElementById('preview-btn');
const previewResult  = document.getElementById('preview-result');
const eventList      = document.getElementById('event-list');

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

// ── Installed skills ──────────────────────────────────────────────────────────

function renderInstalledSkills(domain, resp) {
  const section = document.getElementById('skill-section');
  if (!section) return;

  const header =
    '<div class="skill-divider"></div>' +
    '<div class="skill-label">Installed skills — reusable</div>';

  if (!resp || !resp.ok) {
    const msg = resp?.error ?? 'Aegis API unavailable at localhost:4000.';
    section.innerHTML = header + '<div class="skill-unavailable">' + escHtml(msg) + '</div>';
    return;
  }

  const skills = resp.skills ?? [];
  if (skills.length === 0) {
    section.innerHTML = header + '<div class="skill-empty">No installed skills for this site.</div>';
    return;
  }

  const items = skills.map(s =>
    '<div class="skill-item">' +
      '<div class="skill-name">' + escHtml(s.name) + '</div>' +
      (s.summary ? '<div class="skill-summary">' + escHtml(s.summary) + '</div>' : '') +
      '<div class="skill-meta">' +
        '<span class="skill-tier">' + escHtml(s.trust_tier) + '</span>' +
        '<span class="skill-risk-' + escHtml(s.risk_level) + '">' + escHtml(s.risk_level) + ' risk</span>' +
      '</div>' +
    '</div>'
  ).join('');

  section.innerHTML = header + items;
}

// ── Pending agent runs ────────────────────────────────────────────────────────

function renderPendingRuns(domain, resp) {
  const section = document.getElementById('pending-run-section');
  if (!section) return;

  const header =
    '<div class="skill-divider"></div>' +
    '<div class="skill-label">Pending agent runs — one-time</div>';

  if (!resp || !resp.ok) {
    section.innerHTML = '';
    return;
  }

  const runs = resp.runs ?? [];
  if (runs.length === 0) {
    section.innerHTML = '';
    return;
  }

  const items = runs.map(run => {
    const skillName = escHtml(run.skill_summary?.name ?? run.skill_id);
    const agentId   = escHtml(run.agent_id ?? '—');
    const vars      = run.variables && Object.keys(run.variables).length > 0
      ? Object.entries(run.variables).map(([k, v]) => k + '=' + v).join(', ')
      : '';
    const runJson   = escHtml(JSON.stringify(run));
    return (
      '<div class="run-item">' +
        '<div class="run-skill-name">' + skillName + '</div>' +
        '<div class="run-meta">Agent: ' + agentId + '</div>' +
        (vars ? '<div class="run-vars">' + escHtml(vars) + '</div>' : '') +
        '<button class="start-run-btn" data-run-id="' + escHtml(run.run_id) + '" data-run=\'' + runJson + '\'>Start Run</button>' +
      '</div>'
    );
  }).join('');

  section.innerHTML = header + items;
}

document.addEventListener('click', (e) => {
  if (!e.target.matches('.start-run-btn')) return;
  const btn = e.target;
  let run;
  try { run = JSON.parse(btn.dataset.run); } catch (_) { return; }

  btn.textContent = 'Starting…';
  btn.disabled = true;

  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!tab?.id) { btn.textContent = 'Error'; btn.disabled = false; return; }
    chrome.runtime.sendMessage({ action: 'start_route_run', tabId: tab.id, run }, (resp) => {
      if (!resp?.ok) {
        btn.textContent = 'Error';
        btn.disabled = false;
      }
      // Completion feedback arrives via aegisReplayStatus watcher
    });
  });
});

// ── Storage reads ─────────────────────────────────────────────────────────────

chrome.storage.session.get(['aegisRecorder', 'aegisRecorderEvents'], (result) => {
  applyState(result.aegisRecorder ?? defaultState());
  renderEvents(result.aegisRecorderEvents ?? []);
});

// Show preview section when popup is on a Wikipedia tab; pre-fill route_id from URL hash.
// Also query installed skills for the current domain on every popup open.
(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url) {
    try {
      const u = new URL(tab.url);
      if (u.hostname === 'en.wikipedia.org') {
        previewSection.style.display = 'block';
        const match = u.hash.match(/aegis-preview=([^&]+)/);
        if (match) routeIdInput.value = decodeURIComponent(match[1]);
      }
      chrome.runtime.sendMessage(
        { action: 'list_installed_skills_for_domain', domain: u.hostname },
        (resp) => renderInstalledSkills(u.hostname, resp)
      );
      chrome.runtime.sendMessage(
        { action: 'list_pending_runs_for_domain', domain: u.hostname },
        (resp) => renderPendingRuns(u.hostname, resp)
      );
    } catch (_) {}
  }
})();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session') return;
  if (changes.aegisRecorder)       applyState(changes.aegisRecorder.newValue ?? defaultState());
  if (changes.aegisRecorderEvents) renderEvents(changes.aegisRecorderEvents.newValue ?? []);
  if (changes.aegisReplayStatus) {
    const s = changes.aegisReplayStatus.newValue;
    if (s?.action === 'replay_done') {
      previewResult.textContent = '✓ Replay complete';
      previewResult.className = 'result-ok';
    }
    if (s?.action === 'replay_done' || s?.action === 'replay_failed') {
      chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
        if (!tab?.url) return;
        try {
          const hostname = new URL(tab.url).hostname;
          chrome.runtime.sendMessage(
            { action: 'list_pending_runs_for_domain', domain: hostname },
            (resp) => renderPendingRuns(hostname, resp)
          );
        } catch (_) {}
      });
    }
  }
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

previewBtn.addEventListener('click', async () => {
  const routeId = routeIdInput.value.trim();
  if (!routeId) {
    previewResult.textContent = 'Enter a route ID.';
    previewResult.className = 'result-err';
    return;
  }

  previewBtn.disabled = true;
  previewBtn.textContent = 'Starting…';
  previewResult.textContent = '';
  previewResult.className = '';

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const resp = await chrome.runtime.sendMessage({ action: 'preview', tabId: tab.id, routeId });

  previewBtn.disabled = false;
  previewBtn.textContent = 'Start Preview';

  if (resp?.ok) {
    previewResult.textContent = 'Replaying on page…';
    previewResult.className = 'result-ok';
  } else {
    previewResult.textContent = resp?.error ?? 'Unknown error.';
    previewResult.className = 'result-err';
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
