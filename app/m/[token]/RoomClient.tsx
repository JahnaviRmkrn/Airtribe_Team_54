'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import './room.css';

// Shapes mirror the public room API (see README "Public room API").
type Preferences = {
  budget_min?: number;
  budget_max?: number;
  area?: string;
  food?: string[];
  activities?: string[];
};

type Attendee = {
  id: string;
  guest_name: string;
  preferences: Preferences;
  availability: string[];
  joined_at: string;
};

type Venue = {
  id: string;
  name: string;
  area: string;
  tags: string[];
  price_per_person: number | null;
  details?: string | null;
};

type ShortlistItem = { venue: Venue; score: number; reasons: string[]; label: string };

type RoomView = {
  meetup: {
    title: string;
    activity: string;
    area: string | null;
    starts_at: string | null;
    budget: number | null;
    status: 'open' | 'closed';
    expires_at: string;
    final_venue: Venue | null;
  };
  attendees: Attendee[];
  shortlist: ShortlistItem[];
  shortlist_note: string;
  votes: Record<string, number>;
  leading_venue_id: string | null;
  me: { attendee_id: string; voted_venue_id: string | null } | null;
  is_organizer: boolean;
};

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

type LoadState = 'loading' | 'ready' | 'not-found' | 'failed';

const POLL_MS = 4000; // README: poll the room view every 3-5 s for live updates

const splitList = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

function fmtWhen(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function prefChips(p: Preferences): string[] {
  const chips: string[] = [];
  if (p.area) chips.push(p.area);
  if (p.budget_min != null || p.budget_max != null) {
    chips.push(`₹${p.budget_min ?? 0}–${p.budget_max ?? 'any'} per person`);
  }
  for (const f of p.food ?? []) chips.push(f);
  for (const a of p.activities ?? []) chips.push(a);
  return chips;
}

// The join/edit form shares its fields; values are strings until submit.
type PrefsForm = {
  guest_name: string;
  area: string;
  budget_min: string;
  budget_max: string;
  food: string;
  activities: string;
  availability: string;
};

const emptyForm: PrefsForm = {
  guest_name: '',
  area: '',
  budget_min: '',
  budget_max: '',
  food: '',
  activities: '',
  availability: '',
};

function formFromAttendee(a: Attendee): PrefsForm {
  return {
    guest_name: a.guest_name,
    area: a.preferences.area ?? '',
    budget_min: a.preferences.budget_min != null ? String(a.preferences.budget_min) : '',
    budget_max: a.preferences.budget_max != null ? String(a.preferences.budget_max) : '',
    food: (a.preferences.food ?? []).join(', '),
    activities: (a.preferences.activities ?? []).join(', '),
    availability: (a.availability ?? []).join(', '),
  };
}

function formToBody(form: PrefsForm) {
  const preferences: Preferences = {};
  if (form.area.trim()) preferences.area = form.area.trim();
  if (form.budget_min.trim()) preferences.budget_min = Number(form.budget_min);
  if (form.budget_max.trim()) preferences.budget_max = Number(form.budget_max);
  const food = splitList(form.food);
  if (food.length) preferences.food = food;
  const activities = splitList(form.activities);
  if (activities.length) preferences.activities = activities;
  return { guest_name: form.guest_name.trim(), preferences, availability: splitList(form.availability) };
}

function validateForm(form: PrefsForm): string | null {
  if (!form.guest_name.trim()) return 'Enter your name';
  for (const [label, v] of [
    ['Budget min', form.budget_min],
    ['Budget max', form.budget_max],
  ] as const) {
    if (v.trim() && (!/^\d+$/.test(v.trim()) || Number(v.trim()) < 0)) return `${label} must be a positive whole number`;
  }
  if (form.budget_min.trim() && form.budget_max.trim() && Number(form.budget_min) > Number(form.budget_max)) {
    return 'Budget min is higher than budget max';
  }
  return null;
}

export default function RoomClient() {
  const params = useParams();
  const token = String(params.token ?? '');
  const secretKey = `room_guest_${token}`;

  const [state, setState] = useState<LoadState>('loading');
  const [view, setView] = useState<RoomView | null>(null);
  const [fatalError, setFatalError] = useState('');
  const [notice, setNotice] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<PrefsForm>(emptyForm);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showNotice = useCallback((msg: string) => {
    setNotice(msg);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(''), 6000);
  }, []);

  // Same-origin calls to the public room API. The guest secret is sent as a
  // header (the API also sets an httpOnly cookie on join; the header keeps the
  // guest recognized even where cookies are blocked).
  const callApi = useCallback(
    async (method: string, suffix: string, body?: unknown) => {
      const headers: Record<string, string> = {};
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const secret = localStorage.getItem(secretKey);
      if (secret) headers['X-Guest-Secret'] = secret;
      const res = await fetch(`/api/rooms/${token}${suffix}`, {
        method,
        headers,
        credentials: 'include',
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? 'Something went wrong');
      return data;
    },
    [secretKey, token],
  );

  const refresh = useCallback(
    async (initial = false) => {
      if (initial) setState('loading');
      try {
        const data = (await callApi('GET', '')) as RoomView;
        setView(data);
        setState('ready');
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          setState('not-found');
          return;
        }
        if (initial) {
          setFatalError(e instanceof Error ? e.message : 'Could not load this room');
          setState('failed');
        }
        // During background polling keep showing the last good view.
      }
    },
    [callApi],
  );

  useEffect(() => {
    refresh(true);
  }, [refresh]);

  useEffect(() => {
    if (state !== 'ready') return;
    const t = setInterval(() => refresh(false), POLL_MS);
    return () => clearInterval(t);
  }, [state, refresh]);

  async function run(action: () => Promise<RoomView>, success: string) {
    setBusy(true);
    setActionError('');
    try {
      const data = await action();
      setView(data);
      showNotice(success);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  async function submitJoin(e: React.FormEvent) {
    e.preventDefault();
    const err = validateForm(form);
    if (err) return setActionError(err);
    setBusy(true);
    setActionError('');
    try {
      const data = (await callApi('POST', '/join', formToBody(form))) as {
        attendee_id: string;
        guest_secret: string;
        room: RoomView;
      };
      localStorage.setItem(secretKey, data.guest_secret);
      setView(data.room);
      showNotice(`You’re in, ${form.guest_name.trim()}! Scroll down to vote for a place.`);
    } catch (e2) {
      setActionError(e2 instanceof Error ? e2.message : 'Could not join');
    } finally {
      setBusy(false);
    }
  }

  async function submitEdit(e: React.FormEvent) {
    e.preventDefault();
    const err = validateForm(form);
    if (err) return setActionError(err);
    await run(() => callApi('PATCH', '/me', formToBody(form)) as Promise<RoomView>, 'Your preferences are updated.');
    setEditing(false);
  }

  const setField = (k: keyof PrefsForm) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  if (state === 'loading') {
    return (
      <div className="room-page">
        <div className="room-container">
          <div className="room-card room-state-box">
            <span className="room-spinner" aria-hidden="true" />
            <p className="room-muted">Loading room…</p>
          </div>
        </div>
      </div>
    );
  }

  if (state === 'not-found') {
    return (
      <div className="room-page">
        <div className="room-container">
          <div className="room-card room-state-box">
            <h1>This room link doesn’t work</h1>
            <p className="room-muted">It may have expired, or the link is incomplete. Check with the person who sent it.</p>
          </div>
        </div>
      </div>
    );
  }

  if (state === 'failed' || !view) {
    return (
      <div className="room-page">
        <div className="room-container">
          <div className="room-card room-state-box room-error-card">
            <h1>Couldn’t load this room</h1>
            <p className="room-error">{fatalError}</p>
            <button type="button" className="room-primary" onClick={() => refresh(true)}>
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }

  const { meetup } = view;
  const closed = meetup.status === 'closed';
  const confirmed = meetup.final_venue;
  const meAttendee = view.me ? view.attendees.find((a) => a.id === view.me!.attendee_id) ?? null : null;
  const when = fmtWhen(meetup.starts_at);
  const readOnly = closed || !!confirmed;

  const prefsForm = (
    <form onSubmit={meAttendee ? submitEdit : submitJoin} className="room-form">
      <label>
        Your name
        <input value={form.guest_name} onChange={setField('guest_name')} maxLength={60} required placeholder="e.g. Alex" />
      </label>
      <div className="room-form-grid">
        <label>
          Area you prefer
          <input value={form.area} onChange={setField('area')} maxLength={80} placeholder="e.g. Indiranagar" />
        </label>
        <label>
          When you’re free
          <input value={form.availability} onChange={setField('availability')} placeholder="Sat evening, Sun lunch" />
        </label>
        <label>
          Budget min (₹)
          <input value={form.budget_min} onChange={setField('budget_min')} inputMode="numeric" placeholder="optional" />
        </label>
        <label>
          Budget max (₹)
          <input value={form.budget_max} onChange={setField('budget_max')} inputMode="numeric" placeholder="optional" />
        </label>
        <label>
          Food you like
          <input value={form.food} onChange={setField('food')} placeholder="comma separated" />
        </label>
        <label>
          Activities you like
          <input value={form.activities} onChange={setField('activities')} placeholder="comma separated" />
        </label>
      </div>
      {actionError && <p className="room-error">{actionError}</p>}
      <div className="room-actions">
        <button type="submit" className="room-primary" disabled={busy}>
          {meAttendee ? 'Save changes' : 'Join this meetup'}
        </button>
        {meAttendee && (
          <button type="button" onClick={() => setEditing(false)} disabled={busy}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );

  return (
    <div className="room-page">
      <header className="room-topbar">
        <span className="room-brand">Meetup room</span>
      </header>
      <main className="room-container">
        <div className="room-card">
          <h1>{meetup.title}</h1>
          <p className="room-meta">
            <span className="room-tag">{meetup.activity}</span>
            {meetup.area && <span className="room-tag">{meetup.area}</span>}
            <span className={`room-tag room-status-${meetup.status}`}>{meetup.status}</span>
          </p>
          <p className="room-muted">
            {when && <>When: {when} · </>}
            {meetup.budget != null && <>Budget: up to ₹{meetup.budget} per person · </>}
            {view.attendees.length} {view.attendees.length === 1 ? 'person' : 'people'} in
          </p>
          {view.is_organizer && <p className="room-muted">You’re viewing this as the organiser.</p>}
        </div>

        {closed && (
          <div className="room-card room-state-box">
            <p>This meetup room is closed. Joining, edits and voting are off.</p>
          </div>
        )}

        {confirmed && (
          <div className="room-card room-confirmed">
            <h2>Venue confirmed</h2>
            <p>
              <strong>{confirmed.name}</strong> ({confirmed.area})
              {confirmed.price_per_person != null && <> · ~₹{confirmed.price_per_person} per person</>}
            </p>
            {confirmed.details && <p className="room-muted">{confirmed.details}</p>}
          </div>
        )}

        {notice && (
          <div className="room-card room-notice" role="status">
            {notice}
          </div>
        )}

        {!closed && !meAttendee && (
          <div className="room-card">
            <h2>Join in</h2>
            <p className="room-muted">Add your name and preferences so the organiser can pick a place that works for everyone.</p>
            {prefsForm}
          </div>
        )}

        {meAttendee && !editing && (
          <div className="room-card">
            <h2>You’re in as {meAttendee.guest_name}</h2>
            <div className="room-chips">
              {prefChips(meAttendee.preferences).map((c) => (
                <span key={c} className="room-tag">
                  {c}
                </span>
              ))}
              {meAttendee.availability.map((c) => (
                <span key={c} className="room-tag">
                  {c}
                </span>
              ))}
            </div>
            {!closed && (
              <div className="room-actions">
                <button
                  type="button"
                  onClick={() => {
                    setForm(formFromAttendee(meAttendee));
                    setActionError('');
                    setEditing(true);
                  }}
                >
                  Edit my preferences
                </button>
              </div>
            )}
          </div>
        )}

        {meAttendee && editing && (
          <div className="room-card">
            <h2>Edit your preferences</h2>
            {prefsForm}
          </div>
        )}

        <div className="room-card">
          <h2>Suggested places</h2>
          <p className="room-muted">{view.shortlist_note}</p>
          {view.shortlist.length > 0 && (
            <ul className="room-venues">
              {view.shortlist.map((s) => {
                const count = view.votes[s.venue.id] ?? 0;
                const myVote = view.me?.voted_venue_id === s.venue.id;
                const leading = view.leading_venue_id === s.venue.id && count > 0;
                return (
                  <li key={s.venue.id} className={`room-venue${myVote ? ' room-venue-voted' : ''}`}>
                    <div className="room-venue-head">
                      <strong>{s.venue.name}</strong>
                      <span className="room-tag">{s.label}</span>
                      {leading && <span className="room-tag room-tag-leading">Leading</span>}
                    </div>
                    <p className="room-muted">
                      {s.venue.area}
                      {s.venue.price_per_person != null && <> · ~₹{s.venue.price_per_person} per person</>}
                      {s.venue.details && <> · {s.venue.details}</>}
                    </p>
                    <p className="room-muted">Why: {s.reasons.join('; ')}</p>
                    <div className="room-venue-foot">
                      <span className="room-muted">
                        {count} {count === 1 ? 'vote' : 'votes'}
                      </span>
                      {!readOnly && view.me && (
                        <span className="room-actions">
                          {myVote ? (
                            <>
                              <span className="room-tag room-tag-voted">Your vote</span>
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => run(() => callApi('DELETE', '/vote') as Promise<RoomView>, 'Vote withdrawn.')}
                              >
                                Withdraw
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              className="room-primary"
                              disabled={busy}
                              onClick={() =>
                                run(
                                  () => callApi('POST', '/vote', { venue_id: s.venue.id }) as Promise<RoomView>,
                                  `Vote recorded for ${s.venue.name}.`,
                                )
                              }
                            >
                              Vote
                            </button>
                          )}
                        </span>
                      )}
                      {!readOnly && !view.me && <span className="room-muted">Join above to vote</span>}
                      {view.is_organizer && !readOnly && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            run(
                              () => callApi('POST', '/confirm', { venue_id: s.venue.id }) as Promise<RoomView>,
                              `${s.venue.name} confirmed.`,
                            )
                          }
                        >
                          Confirm as organiser
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="room-card">
          <h2>Who’s coming</h2>
          {view.attendees.length === 0 ? (
            <p className="room-muted">No one has joined yet.</p>
          ) : (
            <ul className="room-attendees">
              {view.attendees.map((a) => (
                <li key={a.id} className="room-attendee">
                  <strong>
                    {a.guest_name}
                    {meAttendee?.id === a.id && <span className="room-tag room-tag-voted"> you</span>}
                  </strong>
                  <span className="room-chips">
                    {a.availability.map((c) => (
                      <span key={c} className="room-tag">
                        {c}
                      </span>
                    ))}
                    {prefChips(a.preferences).map((c) => (
                      <span key={c} className="room-tag">
                        {c}
                      </span>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="room-muted room-live">This page updates automatically every few seconds.</p>
        </div>
      </main>
    </div>
  );
}
