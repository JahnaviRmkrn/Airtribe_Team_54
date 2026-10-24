// Static organizer/room pages do not load the React root layout.
(() => {
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') return;
  window.va = window.va || function (...args) { (window.vaq = window.vaq || []).push(args); };
  window.va('beforeSend', (event) => {
    const url = new URL(event.url);
    if (url.pathname.startsWith('/m/') || url.pathname.startsWith('/room/')) url.pathname = '/m/room';
    else if (url.pathname.startsWith('/organizer/')) url.pathname = '/organizer/';
    else return null;
    url.search = '';
    url.hash = '';
    return { ...event, url: url.toString() };
  });
  window.team54Track = (name) => {
    if (name === 'meetup_created' || name === 'guest_joined') window.va('event', { name });
  };
  const script = document.createElement('script');
  script.src = '/_vercel/insights/script.js';
  script.defer = true;
  document.head.appendChild(script);
})();
