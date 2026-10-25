// RESPONSE-ONLY TEST ADAPTER. Not shipped application security or behavior.
// The fixed fixture refuses consent/start routes separately. This adapter does
// not claim to intercept arbitrary location.assign/replace or address-bar input.
(() => {
  const marker = 'data-team54-fixture-external';
  const blockedPath = '/__harness/blocked-navigation';
  const selector = 'a[href],form[action],[formaction]';
  const counts = { neutralized_links: 0, neutralized_forms: 0, blocked_activations: 0, blocked_windows: 0 };
  let banner;
  const update = () => {
    if (banner) banner.textContent = 'Synthetic fixture safety adapter: external links, forms and windows are disabled. No real Google consent or delivery. Blocked targets: '
      + (counts.neutralized_links + counts.neutralized_forms) + '; activations: ' + counts.blocked_activations + '; windows: ' + counts.blocked_windows + '.';
  };
  const local = raw => {
    try { const url = new URL(raw, location.href); return url.origin === location.origin && !url.username && !url.password && url.protocol === 'http:'; }
    catch { return false; }
  };
  const scrub = node => {
    if (!node?.getAttribute) return;
    const attribute = node.tagName === 'A' ? 'href' : node.tagName === 'FORM' ? 'action' : 'formaction';
    const raw = node.getAttribute(attribute);
    if (raw === null || local(raw)) return;
    if (!node.hasAttribute(marker)) counts[node.tagName === 'A' ? 'neutralized_links' : 'neutralized_forms']++;
    node.setAttribute(marker, 'true');
    node.setAttribute(attribute, blockedPath);
    node.removeAttribute('target'); node.removeAttribute('formtarget');
    node.setAttribute('aria-disabled', 'true');
    node.setAttribute('title', 'External navigation disabled by the synthetic test fixture');
    update();
  };
  const scan = node => {
    if (node?.matches?.(selector)) scrub(node);
    node?.querySelectorAll?.(selector).forEach(scrub);
  };
  const block = event => {
    const element = event.target?.closest?.(`[${marker}],${selector}`);
    const submitter = event.submitter;
    if (element) scrub(element);
    if (submitter) scrub(submitter);
    if (!element?.hasAttribute(marker) && !submitter?.hasAttribute(marker)) return;
    event.preventDefault(); event.stopImmediatePropagation(); counts.blocked_activations++; update();
  };
  for (const type of ['click', 'auxclick', 'submit']) document.addEventListener(type, block, true);
  new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes') scrub(record.target);
      else record.addedNodes.forEach(scan);
    }
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['href', 'action', 'formaction'] });
  const originalOpen = window.open.bind(window);
  window.open = (url = '', ...args) => {
    if (!local(url)) { counts.blocked_windows++; update(); return null; }
    return originalOpen(url, ...args);
  };
  const installBanner = () => {
    banner = document.createElement('aside'); banner.id = 'team54-fixture-navigation';
    banner.setAttribute('role', 'status'); banner.setAttribute('class', 'sheets-note');
    document.body.prepend(banner); scan(document); update();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installBanner, { once: true });
  else installBanner();
  window.__team54FixtureNavigation = Object.freeze({ counts });
})();
