// Served only by the dev harness. No production asset or Auth code is changed.
const status = document.getElementById('status');
async function request(path, body) {
  try {
    const response = await fetch('/__harness/' + path, body ? {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    } : { cache: 'no-store' });
    const result = await response.json();
    status.textContent = JSON.stringify(result, null, 2);
    return response.ok;
  } catch { status.textContent = 'Local server is stopped or unavailable.'; return false; }
}
function clearOrganizerStorage() {
  for (const kind of ['localStorage', 'sessionStorage']) {
    try {
      const storage = window[kind];
      for (const key of Object.keys(storage)) if (key.startsWith('org_')) storage.removeItem(key);
    } catch { /* The app itself handles unavailable browser storage. */ }
  }
}
async function reset(scenario) {
  if (await request('reset', { confirm: 'reset-local-fixture', scenario })) clearOrganizerStorage();
}
document.querySelectorAll('[data-role]').forEach((button) => {
  button.addEventListener('click', () => request('role', { role: button.dataset.role }));
});
document.getElementById('reset').addEventListener('click', () => reset('seeded'));
document.getElementById('reset-empty').addEventListener('click', () => reset('empty'));
document.getElementById('reset-bulk').addEventListener('click', () => reset('bulk1001'));
document.getElementById('fail-contacts').addEventListener('click', () => request('read-failure', { confirm: 'fail-next-contact-page2', target: 'contacts' }));
document.getElementById('fail-dashboard').addEventListener('click', () => request('read-failure', { confirm: 'fail-next-contact-page2', target: 'dashboard' }));
document.getElementById('stop').addEventListener('click', () => request('stop', { confirm: 'stop-local-fixture' }));
document.getElementById('refresh').addEventListener('click', () => request('status'));
request('status');
