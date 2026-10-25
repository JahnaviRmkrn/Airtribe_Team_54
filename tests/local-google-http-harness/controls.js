// Fixed controls only; no SQL, URL, callback, token or arbitrary identity inputs.
const output = document.getElementById('status');
let busy = false;
async function request(path, body) {
  if (busy) return false;
  busy = true;
  const buttons = [...document.querySelectorAll('button')];
  buttons.forEach(button => { button.disabled = true; });
  try {
    const response = await fetch('/__harness/' + path, body ? {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    } : { cache: 'no-store' });
    output.textContent = JSON.stringify(await response.json(), null, 2);
    return response.ok;
  } catch { output.textContent = 'Local fixture is stopped or unavailable.'; return false; }
  finally { busy = false; buttons.forEach(button => { button.disabled = false; }); }
}
document.querySelectorAll('[data-role]').forEach(button => button.onclick = () => request('role', { role: button.dataset.role }));
document.querySelectorAll('[data-connect]').forEach(button => button.onclick = () => request('connect', { purpose: button.dataset.connect, confirm: 'install-synthetic-not-real-consent' }));
document.querySelectorAll('[data-fault]').forEach(button => button.onclick = () => request('fault', { target: button.dataset.fault, confirm: 'arm-one-synthetic-fault' }));
document.getElementById('refresh').onclick = () => request('status');
document.getElementById('stop').onclick = () => request('stop', { confirm: 'stop-local-fixture' });
document.getElementById('reset').onclick = async () => {
  if (!await request('reset', { confirm: 'reset-local-fixture' })) return;
  for (const kind of ['localStorage', 'sessionStorage']) try {
    const storage = window[kind];
    for (const key of Object.keys(storage)) if (key.startsWith('org_')) storage.removeItem(key);
  } catch { /* Storage may be unavailable. */ }
};
request('status');
