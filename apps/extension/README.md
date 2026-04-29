# Aegis Recorder — Chrome Extension

This is the M1 scaffold for the Aegis Rails external recording extension.
It proves the popup → background → content script messaging path.
Full event capture is implemented in M2.

## Load the unpacked extension

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the `apps/extension/` directory from this repo
5. The **Aegis Recorder** extension appears in your toolbar

## Test the messaging path

1. Navigate to `https://en.wikipedia.org` (the first safe external target)
2. Click the **Aegis Recorder** icon in the toolbar
3. The popup opens and shows **Idle**
4. Click **Start Recording**
   - Popup changes to **Recording** with the domain `en.wikipedia.org`
   - Event count starts incrementing every ~2 seconds (heartbeat)
5. Click **Stop Recording**
   - Popup returns to **Idle**
   - Event count stops incrementing

## Inspect background logs

- Go to `chrome://extensions` → find Aegis Recorder → click **Inspect views: service worker**
- The DevTools console shows `[Aegis]` log messages from `background.js` and `content.js`

## Architecture

```
popup.js
  → chrome.runtime.sendMessage({action:"start", tabId, domain})
  → chrome.runtime.sendMessage({action:"stop"})

background.js (service worker)
  → on "start": chrome.scripting.executeScript(content.js)
              + chrome.storage.session.set(state)
  → on "heartbeat": increments eventCount in session storage
  → on "stop": chrome.tabs.sendMessage({action:"stop_recording"})
             + chrome.storage.session.set(state)

content.js
  → sends "recording_started" once on injection
  → sends "heartbeat" every 2s
  → listens for "stop_recording" → clears interval
```

## What is NOT in this increment (M1)

- No DOM event capture (click, change, blur) — that is M2
- No `POST /api/routes/record` — that is M3
- No changes to `apps/api`, `apps/web`, or `apps/mock-store/bank.html`

## Permissions used

| Permission | Why |
|---|---|
| `activeTab` | Access the current tab on user gesture |
| `scripting` | Inject `content.js` dynamically |
| `storage` | Share recording state between popup and background |
| `host_permissions: localhost:4000` | Reserved for M3 API call (unused in M1) |
