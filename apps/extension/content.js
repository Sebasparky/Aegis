// Guard against double-injection (e.g. if popup Start is clicked twice).
if (window.__aegisRecorderActive) {
  // Already running — do nothing.
} else {
  window.__aegisRecorderActive = true;

  console.log('[Aegis] content script loaded on', location.hostname);

  chrome.runtime.sendMessage({ action: 'recording_started', domain: location.hostname });

  // Send a heartbeat every 2 seconds so the popup event count increments
  // and the messaging pipeline is proven. Full event capture is M2.
  window.__aegisRecorderIntervalId = setInterval(() => {
    chrome.runtime.sendMessage({ action: 'heartbeat' });
  }, 2000);

  // Listen for the background worker telling us to stop.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'stop_recording') {
      clearInterval(window.__aegisRecorderIntervalId);
      window.__aegisRecorderActive = false;
      console.log('[Aegis] content script stopped');
    }
  });
}
