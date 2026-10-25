const status = document.getElementById('status');
async function request(path, body) {
  try {
    const response = await fetch('/__harness/' + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
    status.textContent = JSON.stringify(await response.json(), null, 2);
  } catch { status.textContent = 'Local fixture stopped or unavailable.'; }
}
document.querySelectorAll('[data-scenario]').forEach((button) => button.addEventListener('click', () => request('reset', { confirm: 'reset-traction-fixture', scenario: button.dataset.scenario })));
document.querySelectorAll('[data-failure]').forEach((button) => button.addEventListener('click', () => request('read-failure', { confirm: 'fail-next-traction-page2', target: button.dataset.failure })));
document.getElementById('refresh').addEventListener('click', () => request('status'));
document.getElementById('stop').addEventListener('click', () => request('stop', { confirm: 'stop-traction-fixture' }));
request('status');
