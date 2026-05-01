// Guard against double-injection.
if (window.__aegisReplayActive) {
  chrome.runtime.sendMessage({ action: 'replay_ready' });
} else {
  window.__aegisReplayActive = true;

  // ── Styles ───────────────────────────────────────────────────────────────────

  (function injectStyles() {
    if (document.getElementById('aegis-replay-styles')) return;
    const style = document.createElement('style');
    style.id = 'aegis-replay-styles';
    style.textContent = `
      .aegis-highlight {
        outline: 3px solid #3b82f6 !important;
        outline-offset: 3px;
        background-color: rgba(59, 130, 246, 0.08) !important;
        transition: outline 0.15s, background-color 0.15s;
      }
      .aegis-highlight-fill {
        outline-color: #c084fc !important;
        background-color: rgba(192, 132, 252, 0.08) !important;
      }
      #aegis-replay-toast {
        position: fixed;
        bottom: 20px;
        right: 20px;
        background: #1e293b;
        color: #e2e8f0;
        border: 1px solid #334155;
        border-radius: 8px;
        padding: 10px 14px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 12px;
        line-height: 1.4;
        z-index: 2147483647;
        max-width: 280px;
        pointer-events: none;
        box-shadow: 0 4px 12px rgba(0,0,0,0.4);
      }
    `;
    document.head.appendChild(style);
  })();

  // ── Toast ────────────────────────────────────────────────────────────────────

  function showToast(msg) {
    let toast = document.getElementById('aegis-replay-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'aegis-replay-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
  }

  function removeToast() {
    const toast = document.getElementById('aegis-replay-toast');
    if (toast) toast.remove();
  }

  // ── Locator resolution ───────────────────────────────────────────────────────

  function inferRole(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag  = el.tagName.toLowerCase();
    const type = el.type?.toLowerCase();
    if (tag === 'button')   return 'button';
    if (tag === 'a')        return 'link';
    if (tag === 'select')   return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio')    return 'radio';
      if (type === 'submit')   return 'button';
      if (type === 'search')   return 'searchbox';
      return 'textbox';
    }
    return tag;
  }

  function findElement(loc) {
    try {
      switch (loc.type) {
        case 'label': {
          // 1. Direct aria-label match
          const byAria = document.querySelector(`[aria-label="${CSS.escape(loc.name)}"]`);
          if (byAria) return byAria;
          // 2. label[for] association — find label by text, then follow htmlFor
          for (const lbl of document.querySelectorAll('label')) {
            if (lbl.textContent.trim() === loc.name) {
              if (lbl.htmlFor) {
                const target = document.getElementById(lbl.htmlFor);
                if (target) return target;
              }
              const nested = lbl.querySelector('input, select, textarea');
              if (nested) return nested;
            }
          }
          return null;
        }
        case 'placeholder': {
          return [...document.querySelectorAll('[placeholder]')]
            .find(el => el.placeholder === loc.value) ?? null;
        }
        case 'role': {
          const candidates = document.querySelectorAll(
            'button, a, input, select, textarea, [role]'
          );
          for (const el of candidates) {
            if (inferRole(el) !== loc.role) continue;
            const name = el.getAttribute('aria-label') ||
              el.textContent?.trim() ||
              el.value || '';
            if (loc.name && name.toLowerCase().includes(loc.name.toLowerCase())) return el;
          }
          return null;
        }
        case 'css':
          return document.querySelector(loc.value);
        case 'xpath':
          return document.evaluate(
            loc.value, document, null,
            XPathResult.FIRST_ORDERED_NODE_TYPE, null
          ).singleNodeValue;
        default:
          return null;
      }
    } catch (_) {
      return null;
    }
  }

  function findElementWithFallback(step) {
    const candidates = [
      step.target.preferred_locator,
      ...step.target.fallback_locators,
    ];
    for (const loc of candidates) {
      const el = findElement(loc);
      if (el) return { el, loc };
    }
    return { el: null, loc: null };
  }

  // ── Highlight ────────────────────────────────────────────────────────────────

  function highlight(el, isFill) {
    el.classList.add('aegis-highlight');
    if (isFill) el.classList.add('aegis-highlight-fill');
  }

  function unhighlight(el) {
    el.classList.remove('aegis-highlight', 'aegis-highlight-fill');
  }

  // ── Value resolution ─────────────────────────────────────────────────────────

  // Resolves the fill value for a step in priority order:
  // 1. Runtime variable via variable_binding (e.g. variables.username)
  // 2. Legacy query fallback for routes without explicit variable_binding
  // 3. Safe literal default from the route definition
  // Does not expose sensitive_redacted or runtime_variable policy values —
  // those are handled separately by the caller.
  function resolveFillValue(step, variables) {
    if (step.variable_binding && variables[step.variable_binding]) {
      return variables[step.variable_binding];
    }
    if (variables.query) {
      return variables.query;
    }
    if (step.value_policy?.type === 'safe_literal') {
      return step.value_policy.value ?? '';
    }
    return '';
  }

  // ── Replay ───────────────────────────────────────────────────────────────────

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function setInputValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (nativeSetter) {
      nativeSetter.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function waitForValue(el, expected, timeoutMs = 1000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (el.value === expected) return true;
      await sleep(50);
    }
    return el.value === expected;
  }

  function isVisible(el) {
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  }

  function findSearchInputInForm(form) {
    if (!form) return null;
    return (
      form.querySelector('input[name="search"]') ??
      form.querySelector('input[type="search"]') ??
      form.querySelector('input[placeholder*="Search" i]') ??
      form.querySelector('input[type="text"]') ??
      null
    );
  }

  function findBestSearchInput(preferredForm, lastFilled) {
    const inForm = findSearchInputInForm(preferredForm);
    if (inForm) return inForm;
    if (lastFilled?.element && isVisible(lastFilled.element)) return lastFilled.element;
    const candidates = [
      ...document.querySelectorAll('input[name="search"], input[type="search"], input[placeholder*="Search" i]'),
    ];
    const withForm = candidates.filter(el => isVisible(el) && el.closest('form'));
    if (withForm.length > 0) return withForm[0];
    return candidates.find(el => isVisible(el)) ?? null;
  }

  async function replaySteps(route, variables, run_id) {
    const steps = route.steps ?? [];
    let lastFilled = null;
    try {
      for (let i = 0; i < steps.length; i++) {
        const step   = steps[i];
        const label  = `Step ${i + 1}/${steps.length}: ${step.intent.replace(/_/g, ' ')}`;

        chrome.runtime.sendMessage({
          action: 'replay_progress',
          step: i + 1,
          total: steps.length,
          intent: step.intent,
        });

        if (!['fill', 'click', 'submit'].includes(step.action)) {
          await sleep(200);
          continue;
        }

        showToast(label + '…');

        const { el } = findElementWithFallback(step);
        if (!el) {
          showToast(`⚠ ${label} — element not found`);
          chrome.runtime.sendMessage({
            action: 'replay_progress',
            step: i + 1,
            total: steps.length,
            intent: step.intent,
            error: 'Element not found',
          });
          await sleep(1200);
          continue;
        }

        const isFill = step.action === 'fill';
        highlight(el, isFill);
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await sleep(600);

        if (isFill) {
          const vp = step.value_policy;
          if (vp?.type === 'sensitive_redacted' || vp?.type === 'runtime_variable') {
            showToast(`${label} — requires user input`);
            await sleep(1500);
          } else if (vp?.type === 'safe_literal') {
            const fillValue = resolveFillValue(step, variables);

            if (fillValue) {
              el.focus();
              setInputValue(el, '');
              await sleep(50);
              setInputValue(el, fillValue);
              const verified = await waitForValue(el, fillValue, 1000);
              if (!verified) {
                throw new Error(`fill verification failed: expected "${fillValue}", got "${el.value}"`);
              }
              showToast(`${label} — filled "${fillValue}"`);
              await sleep(400);
              lastFilled = { element: el, value: fillValue };
            }
          }
        } else {
          // click / submit
          showToast(`${label} — clicking`);
          await sleep(300);

          const query = variables?.query?.trim();
          let form = el.closest('form');

          if (route.domain === 'en.wikipedia.org' && query) {
            const searchInput = findBestSearchInput(form, lastFilled);
            if (!searchInput) throw new Error('Wikipedia search submit failed: no search input found');

            setInputValue(searchInput, query);
            const svOk = await waitForValue(searchInput, query, 1000);
            if (!svOk) {
              throw new Error(`Wikipedia search input verification failed before submit: expected "${query}", got "${searchInput.value}"`);
            }

            form = searchInput.closest('form') ?? form;
            if (!form) throw new Error('Wikipedia search submit failed: search input has no form');

            const formSearch = findSearchInputInForm(form);
            if (!formSearch || formSearch.value.trim() !== query) {
              throw new Error(`Wikipedia form submit blocked: form search value is "${formSearch?.value ?? '<missing>'}", expected "${query}"`);
            }

            const submitBtn = form.querySelector('button[type="submit"], input[type="submit"], button');
            if (form.requestSubmit) {
              form.requestSubmit(submitBtn ?? undefined);
            } else {
              form.submit();
            }

            unhighlight(el);
            await sleep(800);
            continue;
          }

          el.click();
          // Don't sleep after click — may navigate away immediately.
        }

        unhighlight(el);
      }

      chrome.runtime.sendMessage({ action: 'replay_done', run_id });
      showToast('✓ Replay complete');
      setTimeout(removeToast, 3000);
    } catch (err) {
      chrome.runtime.sendMessage({ action: 'replay_failed', run_id, error: err.message });
      showToast('⚠ Replay failed: ' + err.message);
      setTimeout(removeToast, 4000);
    }
  }

  // ── Message listener ─────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'start_replay') {
      replaySteps(msg.route, msg.variables ?? {}, msg.run_id ?? null);
    }
  });

  chrome.runtime.sendMessage({ action: 'replay_ready' });
}
