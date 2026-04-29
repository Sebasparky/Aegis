// Guard against double-injection (e.g. popup Start clicked twice before stop).
if (window.__aegisRecorderActive) {
  // Already running — do nothing.
} else {
  window.__aegisRecorderActive = true;
  let isActive = true;

  // ── Field resolver (ported from apps/mock-store/bank.html) ──────────────────

  function resolveFieldLabel(el) {
    if (el.id) {
      const lbl = document.querySelector('label[for="' + el.id + '"]');
      if (lbl) return lbl.textContent.trim();
    }
    const parentLabel = el.closest('label');
    if (parentLabel) return parentLabel.textContent.replace(el.value || '', '').trim();
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel;
    const lblBy = el.getAttribute('aria-labelledby');
    if (lblBy) {
      const ref = document.getElementById(lblBy);
      if (ref) return ref.textContent.trim();
    }
    // For button-family elements, prefer visible text/value before name/id/type.
    const _tag = el.tagName.toLowerCase();
    const _isBtn = _tag === 'button' ||
      (_tag === 'input' && ['submit', 'button', 'reset'].includes(el.type));
    if (_isBtn) {
      const vis = el.textContent?.trim();
      if (vis) return vis;
      if (el.value) return el.value;
    }
    if (el.placeholder) return el.placeholder;
    if (el.name) return el.name;
    if (el.id && !/^\d/.test(el.id) && el.id.length < 40) return el.id;
    // For button-type inputs, prefer the value attribute ("Search") over the type name ("submit").
    if (el.tagName.toLowerCase() === 'input' && el.value &&
        ['submit', 'button', 'reset'].includes(el.type)) return el.value;
    if (el.type && el.type !== 'text') return el.type;
    let sib = el.previousSibling;
    while (sib) {
      if (sib.nodeType === 3 && sib.textContent.trim()) return sib.textContent.trim();
      if (sib.nodeType === 1 && sib.textContent.trim()) return sib.textContent.trim();
      sib = sib.previousSibling;
    }
    const heading = el.closest('section, .card, form, fieldset')?.querySelector('h1,h2,h3,h4');
    if (heading) return heading.textContent.trim();
    return null;
  }

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
      return 'textbox';
    }
    if (['h1','h2','h3','h4'].includes(tag)) return 'heading';
    if (tag === 'nav')  return 'navigation';
    if (tag === 'main') return 'main';
    return tag;
  }

  function buildLocators(el, labelText) {
    const locators = [];
    const role        = inferRole(el);
    const visibleText = (el.textContent || el.value || '').trim().slice(0, 80);
    const ariaLabel   = el.getAttribute('aria-label');
    const placeholder = el.placeholder;
    const name        = el.name;
    const elId        = el.id;
    const dataAegis   = el.dataset.aegis;
    const testId      = el.dataset.testid || dataAegis;

    const accessibleName = ariaLabel || labelText || visibleText;
    if (role && accessibleName) {
      locators.push({ type: 'role', role, name: accessibleName });
    }
    if (labelText)  locators.push({ type: 'label', name: labelText });
    if (placeholder) locators.push({ type: 'placeholder', value: placeholder });
    if (dataAegis)  locators.push({ type: 'testid', value: dataAegis });
    if (testId && testId !== dataAegis) locators.push({ type: 'testid', value: testId });
    if (name)  locators.push({ type: 'css', value: '[name="' + name + '"]' });
    if (elId && !/^\d/.test(elId)) locators.push({ type: 'css', value: '#' + elId });
    if (visibleText && role === 'button' && visibleText.length < 30) {
      locators.push({ type: 'css', value: 'button' });
    }
    return locators;
  }

  function isSensitiveField(el, labelText) {
    const SENS = /password|card\s*number|cvv|cvc|security\s*code|ssn|social\s*security|account\s*number|routing/i;
    if (el.type === 'password') return true;
    const ac = el.getAttribute('autocomplete') || '';
    if (/^cc-number$|^cc-csc$|^cc-exp/i.test(ac)) return true;
    if (SENS.test(labelText || ''))    return true;
    if (SENS.test(el.placeholder || '')) return true;
    if (SENS.test(el.name || ''))      return true;
    return false;
  }

  function captureEvent(type, el, extra = {}) {
    if (!isActive) return;

    const labelText   = resolveFieldLabel(el);
    const sensitive   = isSensitiveField(el, labelText);
    const locators    = buildLocators(el, labelText);
    const role        = inferRole(el);
    const visText     = (el.textContent || '').trim().slice(0, 80);
    const ariaLabel   = el.getAttribute('aria-label');
    const autocomplete = el.getAttribute('autocomplete');

    // Nearby context: first heading in nearest semantic container, max 60 chars.
    const nearbyText = el
      .closest('section, form, fieldset, article, main, [role="search"]')
      ?.querySelector('h1,h2,h3,h4,h5')
      ?.textContent
      ?.trim()
      ?.slice(0, 60) || undefined;

    const raw_value = sensitive ? undefined : extra.raw_value;

    const event = {
      type,
      url: window.location.href,
      timestamp: new Date().toISOString(),
      locators,
      element_type: el.tagName.toLowerCase(),
      element_role: role,
      ...(labelText    && { label_text:   labelText }),
      ...(ariaLabel    && { aria_label:   ariaLabel }),
      ...(el.placeholder && { placeholder: el.placeholder }),
      ...(el.name      && { input_name:   el.name }),
      ...(el.id        && { input_id:     el.id }),
      ...(el.type      && { input_type:   el.type }),
      ...(visText      && { visible_text: visText }),
      ...(nearbyText   && { nearby_text:  nearbyText }),
      ...(autocomplete && { autocomplete }),
      ...(raw_value !== undefined && { raw_value }),
      ...(extra.options && { options: extra.options }),
    };

    // Fire-and-forget — background worker buffers and increments count.
    chrome.runtime.sendMessage({ action: 'event', event });
  }

  // ── DOM event listeners (capture phase, event delegation) ───────────────────

  // Clicks: buttons, links, submit inputs.
  document.addEventListener('click', (e) => {
    if (!isActive) return;
    const el = e.target.closest('button, a, [role="button"], input[type="submit"]');
    if (!el) return;
    captureEvent('click', el);
  }, true);

  // Blur: text inputs and textareas — capture after the user finishes typing.
  document.addEventListener('blur', (e) => {
    if (!isActive) return;
    const el  = e.target;
    const tag = el.tagName.toLowerCase();
    if (!['input', 'textarea'].includes(tag)) return;
    if (['submit', 'button', 'reset', 'checkbox', 'radio'].includes(el.type)) return;
    const value = el.value?.trim();
    if (!value) return; // skip empty blurs
    captureEvent('fill', el, { raw_value: value });
  }, true);

  // Change: selects and checkbox/radio toggles.
  document.addEventListener('change', (e) => {
    if (!isActive) return;
    const el = e.target;
    if (el.tagName.toLowerCase() === 'select') {
      const selectedText = el.options[el.selectedIndex]?.text;
      const allOptions   = Array.from(el.options).map(o => o.text).filter(Boolean);
      captureEvent('select', el, { raw_value: selectedText, options: allOptions });
    } else if (['checkbox', 'radio'].includes(el.type)) {
      captureEvent('click', el, { raw_value: el.checked ? 'checked' : 'unchecked' });
    }
  }, true);

  // ── Stop listener ────────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'stop_recording') {
      isActive = false;
      window.__aegisRecorderActive = false;
      console.log('[Aegis] content script stopped on', location.hostname);
    }
  });

  console.log('[Aegis] content script loaded on', location.hostname);
  chrome.runtime.sendMessage({ action: 'recording_started', domain: location.hostname });
}
