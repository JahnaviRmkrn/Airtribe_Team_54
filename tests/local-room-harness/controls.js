// This control UI is served only by the dev harness, never by Next.js.
const status = document.getElementById('status');
async function request(path, body) {
  try {
    const response = await fetch('/__harness/' + path, body ? {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    } : { cache: 'no-store' });
    const result = await response.json();
    // Server responses contain aggregate counts/role only, never cookie values.
    status.textContent = JSON.stringify(result, null, 2);
  } catch { status.textContent = 'Local server is stopped or unavailable.'; }
}
document.querySelectorAll('[data-role]').forEach((button) => {
  button.addEventListener('click', () => request('role', { role: button.dataset.role }));
});
document.getElementById('reset').addEventListener('click', () => request('reset', { confirm: 'reset-local-fixture' }));
document.getElementById('stop').addEventListener('click', () => request('stop', { confirm: 'stop-local-fixture' }));
document.getElementById('refresh').addEventListener('click', () => request('status'));
request('status');

for (const [id, mode] of [['hold-read', 'hold'], ['timeout-read', 'timeout20s']]) {
  document.getElementById(id).addEventListener('click', () => request('read-delay', { confirm: 'delay-next-alice-owner-room-read', target: 'alice-owner-room', mode }));
}
document.getElementById('release-read').addEventListener('click', () => request('release-read', { confirm: 'release-held-room-read' }));
