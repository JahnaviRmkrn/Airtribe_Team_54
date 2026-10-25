// "Meet in the middle" for the guest room.
//   MeetMiddle.render(view)  - fills #meet-card from view.meeting_point + shortlist travel
//   MeetMiddle.locate()      - asks the browser for this guest's location (only on a tap)
// The server works out the middle and ranks venues by the longest trip; this file
// only draws it. Guests' pins are rounded to ~1 km by the server before they get here.
(() => {
  const LEAFLET_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
  const LEAFLET_JS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
  const CSS_SRI = 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=';
  const JS_SRI = 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=';

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // First letter of the first two words; brackets and punctuation are skipped ("Arvind (A)" -> "AA").
  const initials = (name) => (String(name || '').trim().split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean).slice(0, 2).map((w) => [...w][0]).join('') || '?').toUpperCase();

  let leaflet = null;
  let leafletFailed = false;
  let leafletApi = null;
  function loadLeaflet() {
    // Keep failures cached, too: a room poll must never retry external assets.
    // Only the current Retry map button may clear a failed attempt.
    leaflet = leaflet || new Promise((resolve, reject) => {
      const css = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: LEAFLET_CSS, integrity: CSS_SRI, crossOrigin: '' });
      const script = window.L ? null : Object.assign(document.createElement('script'), { src: LEAFLET_JS, integrity: JS_SRI, crossOrigin: '', async: true });
      let styled = false, scripted = !!window.L, settled = false;
      const finish = (failed) => {
        if (settled || (!failed && (!styled || !scripted))) return;
        settled = true;
        clearTimeout(timeout);
        css.onload = css.onerror = null;
        if (script) {
          script.onload = script.onerror = null;
          script.remove();
        }
        leafletFailed = failed;
        if (failed) {
          css.remove();
          reject(new Error('Map failed to load'));
        } else resolve(window.L);
      };
      const timeout = setTimeout(() => finish(true), 10000);
      css.onload = () => { styled = true; finish(false); };
      css.onerror = () => finish(true);
      if (script) {
        script.onload = () => { scripted = !!window.L; finish(!scripted); };
        script.onerror = () => finish(true);
      }
      try {
        document.head.appendChild(css);
        if (script && !settled) document.head.appendChild(script);
      } catch {
        finish(true);
      }
    });
    return leaflet;
  }

  let map = null;
  let mapBox = null;
  let layer = null;
  let lastKey = '';
  let resizeTimer = null;
  let mapState = 'idle';
  let active = null;

  function releaseMap() {
    clearTimeout(resizeTimer);
    resizeTimer = null;
    if (map) map.remove();
    map = mapBox = layer = null;
    lastKey = '';
  }

  function isCurrent(target = active) {
    return target && target === active && target.box.isConnected
      && document.getElementById('meet-card') === target.card
      && target.card.querySelector('.meet-map') === target.box
      && target.card.querySelector('.meet-body') === target.body;
  }

  function drawMap({ box, mp, shortlist }) {
    const L = leafletApi;
    if (!map) {
      map = L.map(box, { scrollWheelZoom: false, attributionControl: true });
      mapBox = box;
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 18,
        attribution: '&copy; OpenStreetMap contributors',
      }).addTo(map);
      layer = L.layerGroup().addTo(map);
    }
    layer.clearLayers();
    const pts = [];
    for (const p of mp.pins || []) {
      pts.push([p.lat, p.lng]);
      L.marker([p.lat, p.lng], { icon: L.divIcon({ className: 'mm-pin', html: esc(initials(p.name)), iconSize: [30, 30] }), title: p.name + ' (approx.)' }).addTo(layer);
    }
    const venues = shortlist.filter((s) => typeof s.venue.lat === 'number');
    venues.forEach((s, i) => {
      L.marker([s.venue.lat, s.venue.lng], { icon: L.divIcon({ className: 'mm-venue' + (i === 0 ? ' best' : ''), html: String(i + 1), iconSize: [24, 24] }) })
        .bindPopup(`<strong>${esc(s.venue.name)}</strong><br>${esc(s.venue.area)}${s.travel ? `<br>Max ${s.travel.max_km} km for anyone` : ''}`)
        .addTo(layer);
    });
    L.marker([mp.lat, mp.lng], { icon: L.divIcon({ className: 'mm-mid', html: '★', iconSize: [34, 34] }), title: 'The middle' })
      .bindPopup(`<strong>The middle</strong><br>near ${esc(mp.near)}`)
      .addTo(layer);
    pts.push([mp.lat, mp.lng]);
    // Refit only when the set of points changes, so polling doesn't fight the user's panning.
    const key = JSON.stringify(pts);
    if (key !== lastKey) {
      map.fitBounds(pts, { padding: [36, 36], maxZoom: 14 });
      lastKey = key;
    }
    clearTimeout(resizeTimer);
    const drawnMap = map;
    resizeTimer = setTimeout(() => {
      if (map === drawnMap && isCurrent() && active.box === box) drawnMap.invalidateSize();
    }, 50);
  }

  function updateMap() {
    if (!isCurrent()) {
      active = null;
      releaseMap();
      return;
    }
    const target = active;
    if (mapState === 'ready') {
      try {
        // Leaflet needs a visible container to calculate its initial bounds.
        target.box.classList.remove('hidden');
        drawMap(target);
      } catch {
        mapState = 'failed';
        releaseMap();
      }
    }
    const ready = mapState === 'ready';
    if (!ready) target.box.classList.add('hidden');
    const status = ready ? '<p class="muted small">Pins are approximate (about 1 km). Exact locations are never shown to others.</p>'
      : `<p class="muted" role="status">${mapState === 'failed' ? 'Map unavailable.' : 'Loading map…'} The middle and trip details above are still available.</p>
        <p class="muted small">Exact locations are never shown to others.</p>
        ${mapState === 'failed' ? '<button class="meet-map-retry btn sm" type="button">Retry map</button>' : ''}`;
    const html = target.details + status;
    if (target.body.innerHTML !== html) target.body.innerHTML = html;
    const retry = target.body.querySelector('.meet-map-retry');
    if (retry) retry.onclick = () => {
      if (!isCurrent(target) || mapState !== 'failed') return;
      if (leafletFailed) leaflet = null;
      startMap();
    };
  }

  function startMap() {
    mapState = 'loading';
    updateMap();
    // One continuation per attempt, not per poll. It uses only the latest view.
    loadLeaflet().then((L) => {
      leafletApi = L;
      mapState = 'ready';
      updateMap();
    }, () => {
      mapState = 'failed';
      updateMap();
    });
  }

  function render(view) {
    const card = document.getElementById('meet-card');
    if (!card || !view) {
      active = null;
      releaseMap();
      if (card) card.classList.add('hidden');
      return;
    }
    card.classList.remove('hidden');
    const mp = view.meeting_point || { people: 0 };
    const body = card.querySelector('.meet-body');
    const box = card.querySelector('.meet-map');
    if (mapBox && mapBox !== box) releaseMap();
    if (typeof mp.lat !== 'number') {
      active = null;
      releaseMap();
      box.classList.add('hidden');
      body.innerHTML = `<p class="muted">${mp.people === 1 ? 'One person has shared where they are coming from. ' : ''}
        When two or more people share where they are coming from (location or area), muop finds a fair middle and ranks places by the longest trip anyone has to make.</p>`;
      return;
    }
    const best = (view.shortlist || []).find((s) => s.travel);
    const details = `
      <p class="meet-headline">The middle is near <strong>${esc(mp.near)}</strong></p>
      <p class="muted">${mp.people} people placed · from the middle, the longest trip is ${mp.max_km} km (average ${mp.avg_km} km)</p>
      ${best ? `<p class="meet-best">Fairest pick so far: <strong>${esc(best.venue.name)}</strong>, ${esc(best.venue.area)}: max ${best.travel.max_km} km for anyone</p>` : ''}`;
    active = { card, body, box, mp, shortlist: view.shortlist || [], details };
    if (mapState === 'idle') startMap();
    else updateMap();
  }

  function locate() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error('This browser cannot share location - type your area instead.'));
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
        (e) => reject(new Error(e.code === 1 ? 'Location permission was denied - type your area instead.' : 'Could not get your location - type your area instead.')),
        { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
      );
    });
  }

  window.MeetMiddle = { render, locate };
})();
