import 'server-only';
import { calendarBody, calendarEventId, gmailRaw, type ActionPreview } from './action-content';

export type ProviderOutcome = { state: 'completed' | 'uncertain' | 'rejected'; providerRef?: string };
const eventUrl = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

// One invocation, one HTTP write, zero retries. Every transport failure, 5xx,
// malformed success or conflict is uncertain. Do not use the read helper here.
export async function performGoogleAction(preview: ActionPreview, id: string, hash: string, token: string): Promise<ProviderOutcome> {
  try {
    const gmail = preview.kind === 'gmail';
    const response = await fetch(gmail ? 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send' : `${eventUrl}?sendUpdates=${preview.sendUpdates}`, {
      method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(gmail ? { raw: gmailRaw(preview) } : calendarBody(preview, id, hash)),
    });
    if ([400, 401, 403, 404, 413, 422, 429].includes(response.status)) return { state: 'rejected' };
    if (!response.ok) return { state: 'uncertain' };
    const data = await response.json();
    if (!data || typeof data.id !== 'string' || !/^[A-Za-z0-9_-]{1,1024}$/.test(data.id) || (!gmail && data.id !== calendarEventId(id))) return { state: 'uncertain' };
    return { state: 'completed', providerRef: data.id };
  } catch { return { state: 'uncertain' }; }
}

// Safe, explicit read-only reconciliation of exactly this event. A 404 is NOT
// permission to insert again: eventual consistency and wrong-account reconnects
// make absence inconclusive. No event lists or calendar lists are fetched.
export async function reconcileCalendarAction(id: string, hash: string, token: string): Promise<ProviderOutcome> {
  try {
    const response = await fetch(`${eventUrl}/${calendarEventId(id)}`, {
      method: 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10000), headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return { state: 'uncertain' };
    const data = await response.json();
    if (data?.status === 'cancelled' || data?.id !== calendarEventId(id) || data?.extendedProperties?.private?.moupAction !== id || data?.extendedProperties?.private?.moupPreview !== hash) return { state: 'uncertain' };
    return { state: 'completed', providerRef: data.id };
  } catch { return { state: 'uncertain' }; }
}
