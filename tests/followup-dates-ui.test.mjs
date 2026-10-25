import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isOverdue } from '../lib/due';

const appPath = fileURLToPath(new URL('../public/organizer/app.js', import.meta.url));
const zones = ['UTC', 'Asia/Kolkata', 'America/New_York'];
// Separate sanitized processes make the actual device timezone deterministic.
// Only the shipped script and synthetic UI/API fixtures are loaded, never .env.
const runner = String.raw`
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const { appPath, now, script, data } = JSON.parse(readFileSync(0, 'utf8'));
const source = readFileSync(appPath, 'utf8').replace(/\nboot\(\);\s*$/, '');
const clock = { now };
const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...args) { super(...(args.length ? args : [clock.now])); }
  static now() { return new RealDate(clock.now).getTime(); }
}
const nodes = new Map();
const document = {
  getElementById(id) {
    if (!nodes.has(id)) {
      let html = '';
      nodes.set(id, { value: '', textContent: '', disabled: false,
        get innerHTML() { return html; },
        set innerHTML(value) {
          html = value;
          for (const match of value.matchAll(/<input\b([^>]*)>/g)) {
            const id = match[1].match(/\bid="([^"]*)"/)?.[1];
            if (id) document.getElementById(id).value = match[1].match(/\bvalue="([^"]*)"/)?.[1] || '';
          }
          for (const match of value.matchAll(/<select\b[^>]*id="([^"]*)"[^>]*>([\s\S]*?)<\/select>/g)) {
            const options = [...match[2].matchAll(/<option\b([^>]*)>/g)];
            const selected = options.find((option) => /\bselected\b/.test(option[1])) || options[0];
            document.getElementById(match[1]).value = selected?.[1].match(/\bvalue="([^"]*)"/)?.[1] || '';
          }
        },
        addEventListener() {}, setAttribute() {}, removeAttribute() {}, focus() {}, scrollIntoView() {},
        querySelectorAll() { return []; }, classList: { add() {}, remove() {}, toggle() {} },
      });
    }
    return nodes.get(id);
  },
  querySelectorAll() { return []; },
};
const store = () => { const data = new Map(); return { getItem: (key) => data.get(key) || null, setItem: (key, value) => data.set(key, value), removeItem: (key) => data.delete(key) }; };
const sessionStorage = store(), localStorage = store();
const context = vm.createContext({ Date: FixedDate, document, clock, data, sessionStorage, localStorage,
  window: { sessionStorage, localStorage }, location: { hash: '#/contacts', origin: 'https://example.test' },
});
vm.runInContext(source, context);
const result = await vm.runInContext('(async () => {' + script + '})()', context);
process.stdout.write(JSON.stringify(result));
`;
function device(zone, script, data = {}, now = '2026-10-25T20:00:00Z') {
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', runner], {
    env: { TZ: zone, LANG: 'en_US.UTF-8' }, encoding: 'utf8', timeout: 10000,
    input: JSON.stringify({ appPath, now, script, data }),
  }));
}
const contact = { id: 'synthetic-contact', name: 'Alice', category: 'personal', interests: [], notes: '', preferred_frequency_days: 14 };

const cases = [
  ['2026-10-25T20:00:00Z', '2026-10-25T00:00:00Z', -1], // Original UTC-device regression.
  ['2026-10-25T18:29:59.999Z', '2026-10-25T00:00:00Z', 0],
  ['2026-10-25T18:30:00Z', '2026-10-25T00:00:00Z', -1],
  ['2026-10-25T20:00:00Z', '2026-10-25T19:00:00Z', 0], // IST day differs from UTC.
  ['2026-10-25T20:00:00Z', '2026-10-27T06:30:00Z', 1],
  ['2026-03-09T04:00:00Z', '2026-03-08T00:00:00Z', -1], // New York spring DST.
  ['2026-11-02T04:30:00Z', '2026-11-01T06:00:00Z', -1], // New York fall DST.
  ['2027-01-01T00:00:00Z', '2026-12-31T18:29:59Z', -1],
  ['2028-03-01T00:00:00Z', '2028-02-29T06:30:00Z', -1],
];

describe.each(zones)('follow-up date policy on %s devices', (zone) => {
  it('matches the real server overdue policy at IST, DST, month/year and leap-day boundaries', () => {
    const actual = device(zone, `return data.cases.map(([now, due]) => dueIn(due, new Date(now)));`, { cases });
    expect(actual).toEqual(cases.map(([, , expected]) => expected));
    for (const [i, [now, due]] of cases.entries()) expect(actual[i] < 0).toBe(isOverdue(due, new Date(now)));
  });

  it('treats missing/invalid due dates as unscheduled without crashing labels or the calendar', () => {
    const result = device(zone, `
      const values = [null, undefined, '', 'not-a-date'];
      const contacts = values.map((next_followup_at) => ({ ...data.contact, next_followup_at }));
      const html = calendarHTML(contacts, []);
      return { values: values.map((value) => [dueIn(value), followupDay(value), fmtFollowupDay(value)]),
        invalidNow: dueIn('2026-10-25T00:00:00Z', new Date('bad')), events: window.__calEvents,
        rows: contacts.map(contactRow), graph: networkGraphSVG(contacts), html };
    `, { contact });
    expect(result.values).toEqual(Array.from({ length: 4 }, () => [null, '', '']));
    for (const due of [null, undefined, '', 'not-a-date']) expect(isOverdue(due)).toBe(false);
    expect(result.invalidNow).toBeNull();
    expect(result.events).toEqual({});
    expect(result.rows.every((row) => row.includes('No check-in scheduled'))).toBe(true);
    expect(result.graph).toContain('no check-in date');
    expect(result.html).not.toContain('Invalid Date');
  });

  it('uses IST labels consistently across badges, rows, graph, dashboard and profile', () => {
    const result = device(zone, `
      const c = { ...data.contact, next_followup_at: '2026-10-24T20:00:00Z' };
      const label = new Date(c.next_followup_at).toLocaleDateString(undefined, { dateStyle: 'medium', timeZone: 'Asia/Kolkata' });
      api = async (path) => path === '/api/me/dashboard'
        ? { is_empty: false, followups: { overdue: [c], upcoming: [] } }
        : path === '/api/me/contacts' ? { contacts: [c] } : { contact: c, interactions: [] };
      await dashboardView(); const dashboard = el('app').innerHTML;
      await contactDetailView(c.id); const profile = el('app').innerHTML;
      return { label, row: contactRow(c), people: peopleCard([c]), graph: networkGraphSVG([c]), dashboard, profile };
    `, { contact });
    expect(result.label).toBe('Oct 25, 2026');
    expect(result.row).toContain('Was due ' + result.label);
    expect(result.people).toContain('due-late');
    expect(result.graph).toContain('next check-in ' + result.label);
    expect(result.dashboard).toContain('Was due ' + result.label);
    expect(result.dashboard).toContain('1</span><span>check-in overdue');
    expect(result.profile).toContain('Check-in overdue by 1 day');
    expect(result.profile).toContain(result.label);
  });

  it('separates Today summaries while keeping follow-up dates IST and meetup dates device-local', () => {
    const result = device(zone, `
      const iso = '2026-10-25T20:00:00Z';
      const html = calendarHTML([{ ...data.contact, next_followup_at: iso }], [{ title: 'Meetup', starts_at: iso }]);
      wireCalendar();
      const local = new Date(iso);
      return { html, events: window.__calEvents, today: window.__calToday, detail: el('cal-detail').innerHTML,
        meetupDay: local.getDate(), meetupTime: local.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) };
    `, { contact });
    expect(result.today).toBe('2026-10-26');
    expect(result.html).not.toContain('aria-current="date"');
    expect(result.html).not.toMatch(/class="cal-cell[^"]*cal-today/);
    expect(result.html).toContain('Check-ins today (IST)');
    expect(result.html).toContain('Upcoming meetups today (');
    expect(result.html).toContain('Calendar dates: check-ins use IST (Asia/Kolkata); meetups use your device');
    expect(result.events[26]).toContainEqual(expect.objectContaining({ kind: 'followup', label: 'Alice', status: 'soon' }));
    expect(result.events[result.meetupDay]).toContainEqual({ kind: 'meetup', label: 'Meetup', time: result.meetupTime });
    expect(result.detail).toContain('Monday, October 26');
    expect(result.detail).toContain('Alice');
  });

  it('never includes a device-tomorrow meetup in either Today summary, even on the IST-selected date', () => {
    const result = device(zone, `
      const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(10, 0, 0, 0);
      const html = calendarHTML([{ ...data.contact, next_followup_at: '2026-10-24T20:00:00Z' }],
        [{ title: 'Device tomorrow', starts_at: tomorrow.toISOString() }]);
      wireCalendar();
      return { html, summaries: [...html.matchAll(/<section aria-label="[^\"]*today[^\"]*">([\\s\\S]*?)<\\/section>/g)].map((m) => m[1]),
        detail: el('cal-detail').innerHTML, sameGridDay: tomorrow.getDate() === Number(window.__calToday.slice(8, 10)) };
    `, { contact }, '2026-10-24T20:00:00Z');
    expect(result.summaries).toHaveLength(2);
    expect(result.summaries[0]).toContain('Alice');
    expect(result.summaries[1]).toContain('No upcoming meetups today.');
    for (const summary of result.summaries) expect(summary).not.toContain('Device tomorrow');
    expect(result.html).not.toContain('aria-current="date"');
    if (result.sameGridDay) {
      expect(result.detail).toContain('Device tomorrow');
      expect(result.detail).toContain('Calendar date:');
      expect(result.detail).toContain('(device time)');
      expect(result.detail).not.toContain('Today');
    }
  });

  it.each([
    ['2026-10-31T20:00:00Z', '2026-10-31T21:00:00Z', 'November 2026'],
    ['2026-12-31T20:00:00Z', '2026-12-31T21:00:00Z', 'January 2027'],
  ])('keeps device-today meetups visible outside the IST grid month at %s', (now, startsAt, month) => {
    const result = device(zone, `
      const html = calendarHTML([], [{ title: 'Device today', starts_at: data.startsAt },
        { title: 'Unscheduled', starts_at: null }, { title: 'Invalid', starts_at: 'not-a-date' }]);
      const meetupSummary = html.match(/<section aria-label="Meetups today in [^\"]*">([\\s\\S]*?)<\\/section>/)[1];
      return { html, meetupSummary, events: window.__calEvents,
        localMonth: new Date(data.startsAt).getMonth() + 1, istMonth: Number(window.__calToday.slice(5, 7)) };
    `, { startsAt }, now);
    expect(result.html).toContain(month + ' (current IST month)');
    expect(result.meetupSummary).toContain('Device today');
    expect(result.meetupSummary).not.toContain('No upcoming meetups today.');
    expect(result.meetupSummary).not.toContain('Unscheduled');
    expect(result.meetupSummary).not.toContain('Invalid');
    if (result.localMonth !== result.istMonth) expect(result.events).toEqual({});
  });

  it('keeps the calendar month and selected-day detail stable across midnight/year rollover', () => {
    const result = device(zone, `
      const html = calendarHTML([{ ...data.contact, next_followup_at: '2026-12-31T19:00:00Z' }], []);
      clock.now = '2027-02-01T20:00:00Z';
      wireCalendar();
      return { html, detail: el('cal-detail').innerHTML, today: window.__calToday };
    `, { contact }, '2026-12-31T20:00:00Z');
    expect(result.today).toBe('2027-01-01');
    expect(result.html).toContain('January 2027');
    expect(result.html).toContain('January 2027 (current IST month)');
    expect(result.html).not.toContain('aria-current="date"');
    expect(result.detail).toContain('Friday, January 1');
    expect(result.detail).toContain('Alice');
  });

  it('round-trips date-only inputs and rejects invalid days without depending on device DST', () => {
    const days = ['2026-10-26', '2026-03-08', '2026-11-01', '2028-02-29'];
    const result = device(zone, `return {
      valid: data.days.map((day) => ({ iso: followupISO(day), day: followupDay(followupISO(day)) })),
      empty: [followupISO(null) ?? null, followupISO('') ?? null],
      invalid: ['bad', '2026-02-30', '2027-02-29', '2026-13-01', '0000-01-01'].map((day) => {
        try { followupISO(day); return false; } catch { return true; }
      }),
    };`, { days });
    expect(result.valid).toEqual(days.map((day) => ({ iso: day + 'T06:30:00.000Z', day })));
    expect(result.empty).toEqual([null, null]);
    expect(result.invalid.every(Boolean)).toBe(true);
  });

  it('saves Add dates at noon IST and prefills Edit with the same date, without rewriting on notes-only edits', () => {
    const result = device(zone, `
      api = async () => ({ contacts: [] });
      let saved;
      createContactsOnce = async (_kind, body) => { saved = { ...data.contact, ...body }; return { contacts: [saved] }; };
      await contactsView();
      el('c-name').value = 'Alice'; el('c-next').value = '2026-11-01';
      await el('add-form').onsubmit({ preventDefault() {} });
      contactDetailView = async () => {};
      editContactForm(saved.id, saved); const prefill = el('e-next').value;
      const writes = []; api = async (_path, opts) => { writes.push(JSON.parse(opts.body)); return {}; };
      el('e-notes').value = 'Changed note'; await el('e-save').onclick();
      editContactForm(saved.id, saved); el('e-next').value = '2026-11-02'; await el('e-save').onclick();
      editContactForm(saved.id, saved); el('e-next').value = ''; await el('e-save').onclick();
      return { saved, prefill, writes };
    `, { contact });
    expect(result.saved.next_followup_at).toBe('2026-11-01T06:30:00.000Z');
    expect(result.prefill).toBe('2026-11-01');
    expect(result.writes).toEqual([{ notes: 'Changed note' }, { next_followup_at: '2026-11-02T06:30:00.000Z' }, { next_followup_at: null }]);
  });

  it('preserves precise legacy instants on unchanged edit and restored retry, even when UTC/local day differs', () => {
    const original = '2026-10-25T20:15:30.123456+00:00';
    const result = device(zone, `
      const c = { ...data.contact, next_followup_at: data.original };
      contactDetailView = async () => {};
      editContactForm(c.id, c); const prefill = el('e-next').value;
      const writes = []; api = async (_path, opts) => { if (opts) writes.push(JSON.parse(opts.body)); return { contacts: [] }; };
      await el('e-save').onclick();
      editContactForm(c.id, c); el('e-notes').value = 'Notes only'; await el('e-save').onclick();
      pendingContactIntent = () => ({ body: c });
      await contactsView(); const retryDay = el('c-next').value;
      let retry;
      createContactsOnce = async (_kind, body) => { retry = body; return { contacts: [c] }; };
      await el('add-form').onsubmit({ preventDefault() {} });
      return { original: c.next_followup_at, prefill, writes, retryDay, retry };
    `, { contact, original });
    expect(result.original).toBe(original);
    expect(result.prefill).toBe('2026-10-26');
    expect(result.writes).toEqual([{ notes: 'Notes only' }]);
    expect(result.retryDay).toBe('2026-10-26');
    expect(result.retry.next_followup_at).toBe(original);
  });

  it('uses the same date conversion for dashboard Mark done and profile Log a check-in', () => {
    const result = device(zone, `
      const writes = [];
      api = async (_path, opts) => {
        if (opts) writes.push(JSON.parse(opts.body));
        return { contact: data.contact, interactions: [] };
      };
      dashboardView = async () => {};
      const fields = Object.fromEntries(['note', 'next', 'save', 'cancel', 'error'].map((id) => [id, { value: '', textContent: '' }]));
      const row = { innerHTML: '', querySelector: (selector) => fields[selector.match(/data-fu="([^"]+)"/)[1]] };
      markDoneForm({ dataset: { done: data.contact.id, name: data.contact.name }, closest: () => row });
      fields.next.value = '2026-03-08'; await fields.save.onclick();
      await contactDetailView(data.contact.id);
      el('log-next').value = '2026-11-01'; await el('log-form').onsubmit({ preventDefault() {} });
      return writes;
    `, { contact });
    expect(result.map((write) => write.next_followup_at)).toEqual(['2026-03-08T06:30:00.000Z', '2026-11-01T06:30:00.000Z']);
  });

  it('shows invalid date errors without submitting or leaving Mark done disabled', () => {
    const result = device(zone, `
      const writes = []; api = async (_path, opts) => { if (opts) writes.push(opts); return {}; };
      contactDetailView = async () => {};
      const fields = Object.fromEntries(['note', 'next', 'save', 'cancel', 'error'].map((id) => [id, { value: '', textContent: '' }]));
      const row = { innerHTML: '', querySelector: (selector) => fields[selector.match(/data-fu="([^\"]+)"/)[1]] };
      markDoneForm({ dataset: { done: data.contact.id, name: data.contact.name }, closest: () => row });
      fields.next.value = '2026-02-30'; await fields.save.onclick();
      editContactForm(data.contact.id, data.contact); el('e-next').value = 'invalid'; await el('e-save').onclick();
      return { writes, doneError: fields.error.textContent, disabled: fields.save.disabled, editError: el('e-error').textContent };
    `, { contact });
    expect(result.writes).toEqual([]);
    expect(result.doneError).toBe('Choose a valid follow-up date.');
    expect(result.disabled).toBe(false);
    expect(result.editError).toBe('Choose a valid follow-up date.');
  });

  it('leaves meetup/history display and the explicit UTC meetup editor unchanged', () => {
    const result = device(zone, `
      const iso = '2026-11-01T01:30:45.123456-04:00';
      const d = new Date(iso);
      return { actual: [fmtDate(iso), fmtDay(iso)], expected: [
        d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
        d.toLocaleDateString(undefined, { dateStyle: 'medium' })],
        utc: meetupUtcISO('2026-11-01T01:30'), edit: meetupUtcInput(iso) };
    `);
    expect(result.actual).toEqual(result.expected);
    expect(result.utc).toBe('2026-11-01T01:30:00.000Z');
    expect(result.edit).toBe('2026-11-01T05:30:45.123');
  });
});


describe('device dates ahead of IST', () => {
  it.each([
    ['2026-10-31T12:00:00Z', '2026-10-31T13:00:00Z', 'October 2026', 'November 1'],
    ['2026-12-31T12:00:00Z', '2026-12-31T13:00:00Z', 'December 2026', 'January 1'],
  ])('retains device-today meetups in the following month/year at %s', (now, startsAt, gridMonth, deviceDay) => {
    const result = device('Pacific/Auckland', `
      const html = calendarHTML([], [{ title: 'Ahead-of-IST meetup', starts_at: data.startsAt }]);
      const summary = html.match(/<section aria-label="Meetups today in [^\"]*">([\\s\\S]*?)<\\/section>/)[1];
      return { html, summary, events: window.__calEvents };
    `, { startsAt }, now);
    expect(result.html).toContain(gridMonth + ' (current IST month)');
    expect(result.summary).toContain('Ahead-of-IST meetup');
    expect(result.summary).toContain(deviceDay);
    expect(result.summary).toContain('Pacific/Auckland');
    expect(result.events).toEqual({});
  });
});
