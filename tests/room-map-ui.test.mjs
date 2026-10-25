import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// Execute the shipped map script. DOM, timers and Leaflet are synthetic: these
// tests neither load a provider resource nor request a browser location.
const source = readFileSync(new URL('../public/room/meet.js', import.meta.url), 'utf8');
const flush = async () => { await new Promise((resolve) => setImmediate(resolve)); };
const view = (near = 'Central') => ({
  meeting_point: {
    people: 2, lat: 12.9, lng: 77.6, near, max_km: 5, avg_km: 3,
    pins: [{ name: '<Guest A>', lat: 12.91, lng: 77.61 }, { name: 'Guest B', lat: 12.92, lng: 77.62 }],
  },
  shortlist: [{ venue: { name: 'Cafe <A>', area: 'Central', lat: 12.93, lng: 77.63 }, travel: { max_km: 4 } }],
});

function element(tag = 'div') {
  const classes = new Set();
  let html = '';
  const children = new Map();
  return {
    tag, isConnected: true, onclick: null,
    get innerHTML() { return html; },
    set innerHTML(value) {
      html = value;
      for (const child of children.values()) child.isConnected = false;
      children.clear();
      if (html.includes('class="meet-map-retry')) children.set('.meet-map-retry', element('button'));
    },
    querySelector: (selector) => children.get(selector) || null,
    classList: {
      add: (name) => classes.add(name), remove: (name) => classes.delete(name), contains: (name) => classes.has(name),
    },
  };
}

function roomMap() {
  let currentCard, timerId = 0;
  const assets = [], timers = new Map(), maps = [], markers = [];
  const newCard = () => {
    const body = element(), box = element();
    const card = Object.assign(element(), { body, box });
    card.querySelector = (selector) => ({ '.meet-body': card.body, '.meet-map': card.box })[selector] || null;
    return card;
  };
  currentCard = newCard();
  const document = {
    getElementById: (id) => id === 'meet-card' ? currentCard : null,
    createElement: (tag) => ({ tag, onload: null, onerror: null, removed: false, remove() { this.removed = true; } }),
    head: { appendChild: (asset) => { assets.push(asset); } },
  };
  const window = {};
  const context = vm.createContext({
    document, window,
    navigator: { geolocation: { getCurrentPosition() { throw new Error('Unexpected location request'); } } },
    fetch() { throw new Error('Unexpected external request'); },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
  });
  vm.runInContext(source, context);
  const library = {
    map(box) {
      const map = { box, fitCalls: [], invalidations: 0, removed: false,
        fitBounds(points) { this.fitCalls.push(points); }, invalidateSize() { this.invalidations++; }, remove() { this.removed = true; },
      };
      maps.push(map);
      return map;
    },
    tileLayer: () => ({ addTo() {} }),
    layerGroup: () => ({ clearLayers() {}, addTo() { return this; } }),
    divIcon: (options) => options,
    marker(point, options) {
      const marker = { point, options, popup: '', addTo() { markers.push(this); return this; }, bindPopup(html) { this.popup = html; return this; } };
      return marker;
    },
  };
  return {
    assets, maps, markers, timers, window, library, document,
    get card() { return currentCard; },
    get html() { return currentCard?.body.innerHTML || ''; },
    get retry() { return currentCard?.body.querySelector('.meet-map-retry'); },
    render: (next = view()) => window.MeetMiddle.render(next),
    latest: (tag) => assets.filter((asset) => asset.tag === tag).at(-1),
    live: (tag) => assets.filter((asset) => !asset.removed && (!tag || asset.tag === tag)),
    detach() { currentCard.isConnected = currentCard.box.isConnected = currentCard.body.isConnected = false; currentCard = null; },
    replace() {
      currentCard.isConnected = currentCard.box.isConnected = currentCard.body.isConnected = false;
      currentCard = newCard();
    },
    replaceBox() { currentCard.box.isConnected = false; currentCard.box = element(); },
    async loaded() {
      window.L = library;
      this.latest('link')?.onload?.();
      this.latest('script')?.onload?.();
      await flush();
    },
    async fail(tag = 'script') { this.latest(tag).onerror(); await flush(); },
    async tick(ms) {
      for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); timer.fn(); }
      await flush();
    },
  };
}

describe('shipped room map loading and failure recovery', () => {
  it('shows loading without claiming visible pins and keeps the middle and fairest pick readable', () => {
    const app = roomMap();
    app.render();
    expect(app.html).toContain('Loading map');
    expect(app.html).toContain('The middle is near');
    expect(app.html).toContain('Cafe &lt;A&gt;');
    expect(app.html).not.toContain('Pins are approximate');
    expect(app.card.box.classList.contains('hidden')).toBe(true);
    expect(app.assets.map((asset) => asset.tag)).toEqual(['link', 'script']);
  });

  it.each(['script', 'link'])('shows a truthful fallback and cleans up a failed %s without retrying on polls', async (tag) => {
    const app = roomMap();
    app.render();
    await app.fail(tag);
    for (let i = 0; i < 10; i++) { app.render(view(`Updated ${i}`)); await flush(); }
    expect(app.html).toContain('Map unavailable');
    expect(app.html).toContain('Updated 9');
    expect(app.html).toContain('Fairest pick so far');
    expect(app.html).not.toContain('Pins are approximate');
    expect(app.retry).not.toBeNull();
    expect(app.assets).toHaveLength(2);
    expect(app.live()).toEqual([]);
    expect(app.timers.size).toBe(0);
    for (const asset of app.assets) expect([asset.onload, asset.onerror]).toEqual([null, null]);
  });

  it('treats a script load without a Leaflet global as a stable failure', async () => {
    const app = roomMap();
    app.render();
    app.latest('script').onload();
    await flush();
    expect(app.html).toContain('Map unavailable');
    app.render();
    await flush();
    expect(app.assets).toHaveLength(2);
    expect(app.live()).toEqual([]);
  });

  it('cleans up a synchronous asset insertion failure and allows a real retry', async () => {
    const app = roomMap();
    const append = app.document.head.appendChild;
    app.document.head.appendChild = (asset) => { append(asset); throw new Error('Synthetic insertion failure'); };
    app.render();
    await flush();
    expect(app.html).toContain('Map unavailable');
    expect(app.live()).toEqual([]);
    expect(app.timers.size).toBe(0);
    app.document.head.appendChild = append;
    app.retry.onclick();
    await app.loaded();
    expect(app.maps).toHaveLength(1);
  });

  it('waits for styles as well as the script before claiming the map is ready', async () => {
    const app = roomMap();
    app.render();
    app.window.L = app.library;
    app.latest('script').onload();
    await flush();
    expect(app.maps).toEqual([]);
    expect(app.html).toContain('Loading map');
    app.latest('link').onload();
    await flush();
    expect(app.maps).toHaveLength(1);
    expect(app.html).toContain('Pins are approximate');
  });

  it('times out a stalled request and ignores its late event until an explicit retry', async () => {
    const app = roomMap();
    app.render();
    const lateLoad = app.latest('script').onload;
    await app.tick(10000);
    expect(app.html).toContain('Map unavailable');
    app.window.L = app.library;
    lateLoad();
    app.render();
    await flush();
    expect(app.maps).toEqual([]);
    expect(app.assets).toHaveLength(2);
    expect(app.live()).toEqual([]);
    app.retry.onclick();
    await app.loaded();
    expect(app.maps).toHaveLength(1);
    expect(app.live('link')).toHaveLength(1);
  });

  it('shares one pending attempt across polls and draws only the latest data', async () => {
    const app = roomMap();
    app.render();
    for (let i = 0; i < 10; i++) app.render(view(`Middle ${i}`));
    expect(app.assets).toHaveLength(2);
    await app.loaded();
    expect(app.maps).toHaveLength(1);
    expect(app.markers).toHaveLength(4);
    expect(app.markers.at(-1).popup).toContain('Middle 9');
    expect(app.html).toContain('Pins are approximate (about 1 km)');
    expect(app.html).toContain('Exact locations are never shown to others');
    expect(app.html).not.toContain('Loading map');
    expect(app.card.box.classList.contains('hidden')).toBe(false);
  });

  it('retries only on a current button tap, ignores duplicate taps and recovers after failure', async () => {
    const app = roomMap();
    app.render();
    const lateError = app.latest('script').onerror;
    await app.fail();
    const retry = app.retry.onclick;
    retry();
    retry();
    expect(app.html).toContain('Loading map');
    expect(app.assets).toHaveLength(4);
    lateError();
    await app.loaded();
    expect(app.maps).toHaveLength(1);
    expect(app.html).not.toContain('Map unavailable');
    expect(app.retry).toBeNull();
    expect(app.live('script')).toEqual([]);
    expect(app.live('link')).toHaveLength(1);
    for (const asset of app.assets) expect([asset.onload, asset.onerror]).toEqual([null, null]);
  });

  it('does not bypass a failed stylesheet merely because the script loaded', async () => {
    const app = roomMap();
    app.render();
    app.window.L = app.library;
    app.latest('script').onload();
    await app.fail('link');
    app.render();
    expect(app.html).toContain('Map unavailable');
    expect(app.maps).toEqual([]);
    app.retry.onclick();
    expect(app.assets.filter((asset) => asset.tag === 'link')).toHaveLength(2);
    expect(app.assets.filter((asset) => asset.tag === 'script')).toHaveLength(1);
    await app.loaded();
    expect(app.maps).toHaveLength(1);
  });

  it('keeps subsequent failed retries bounded and waits for another explicit tap', async () => {
    const app = roomMap();
    app.render();
    await app.fail();
    app.retry.onclick();
    await app.fail();
    for (let i = 0; i < 10; i++) app.render();
    await flush();
    expect(app.assets).toHaveLength(4);
    expect(app.live()).toEqual([]);
    expect(app.html).toContain('Map unavailable');
  });

  it('preserves a working map and its panned view across unchanged polls', async () => {
    const app = roomMap();
    app.render();
    await app.loaded();
    for (let i = 0; i < 10; i++) { app.render(); await flush(); }
    expect(app.maps).toHaveLength(1);
    expect(app.maps[0].fitCalls).toHaveLength(1);
    expect(app.assets).toHaveLength(2);
    expect(app.timers.size).toBe(1);
    await app.tick(50);
    expect(app.maps[0].invalidations).toBe(1);
    expect(app.markers[0].point).toEqual([12.91, 77.61]);
    expect(app.markers[0].options.title).toBe('<Guest A> (approx.)');
  });
});

describe('shipped room map lifecycle', () => {
  it.each(['no middle', 'cleared view', 'removed card'])('discards a late load after %s', async (change) => {
    const app = roomMap();
    app.render();
    if (change === 'no middle') app.render({ meeting_point: { people: 1 }, shortlist: [] });
    else if (change === 'cleared view') app.render(null);
    else app.detach();
    await app.loaded();
    expect(app.maps).toEqual([]);
    if (change === 'no middle') expect(app.html).toContain('One person');
  });

  it.each([false, true])('uses only the replacement container after a late result (rendered: %s)', async (rendered) => {
    const app = roomMap();
    app.render();
    app.replace();
    if (rendered) app.render(view('Replacement'));
    await app.loaded();
    if (!rendered) {
      expect(app.maps).toEqual([]);
      app.render(view('Replacement'));
      await flush();
    }
    expect(app.maps).toHaveLength(1);
    expect(app.maps[0].box).toBe(app.card.box);
    expect(app.markers.at(-1).popup).toContain('Replacement');
  });

  it('disposes an old map, ignores stale resize callbacks and initializes the replacement', async () => {
    const app = roomMap();
    app.render();
    await app.loaded();
    const oldMap = app.maps[0];
    const oldResize = [...app.timers.values()].find((timer) => timer.ms === 50).fn;
    app.replace();
    app.render();
    await flush();
    oldResize();
    expect(oldMap.removed).toBe(true);
    expect(oldMap.invalidations).toBe(0);
    expect(app.maps).toHaveLength(2);
    expect(app.maps[1].box).toBe(app.card.box);
    expect(app.maps[1].fitCalls).toHaveLength(1);
    await app.tick(50);
    expect(app.maps[1].invalidations).toBe(1);
  });

  it.each([false, true])('handles replacement of just the map element (already loaded: %s)', async (loaded) => {
    const app = roomMap();
    app.render();
    if (loaded) await app.loaded();
    const oldBox = app.card.box;
    app.replaceBox();
    app.render();
    await app.loaded();
    expect(app.maps.at(-1).box).toBe(app.card.box);
    expect(app.maps.at(-1).box).not.toBe(oldBox);
    expect(app.maps).toHaveLength(loaded ? 2 : 1);
    if (loaded) expect(app.maps[0].removed).toBe(true);
  });

  it('clears a ready map on navigation and reuses healthy assets on a later view', async () => {
    const app = roomMap();
    app.render();
    await app.loaded();
    const oldResize = [...app.timers.values()].find((timer) => timer.ms === 50).fn;
    app.render(null);
    oldResize();
    expect(app.maps[0].removed).toBe(true);
    expect(app.maps[0].invalidations).toBe(0);
    expect(app.card.classList.contains('hidden')).toBe(true);
    expect(app.timers.size).toBe(0);
    app.render(view('Returned'));
    expect(app.maps).toHaveLength(2);
    expect(app.assets).toHaveLength(2);
    expect(app.html).toContain('Returned');
  });

  it('disposes the map when locations disappear and ignores a detached Retry map button', async () => {
    const app = roomMap();
    app.render();
    await app.fail();
    const oldRetry = app.retry.onclick;
    app.render({ meeting_point: { people: 0 }, shortlist: [] });
    oldRetry();
    expect(app.assets).toHaveLength(2);
    app.render();
    app.retry.onclick();
    await app.loaded();
    app.render({ meeting_point: { people: 0 }, shortlist: [] });
    expect(app.maps[0].removed).toBe(true);
    expect(app.timers.size).toBe(0);
  });

  it('recovers a rendering failure without reloading healthy assets', async () => {
    const app = roomMap();
    const tileLayer = app.library.tileLayer;
    app.library.tileLayer = () => { throw new Error('Synthetic map setup failure'); };
    app.render();
    await app.loaded();
    expect(app.html).toContain('Map unavailable');
    expect(app.maps[0].removed).toBe(true);
    app.library.tileLayer = tileLayer;
    app.retry.onclick();
    await flush();
    expect(app.maps).toHaveLength(2);
    expect(app.maps[1].removed).toBe(false);
    expect(app.assets).toHaveLength(2);
    expect(app.html).toContain('Pins are approximate');
  });
});
