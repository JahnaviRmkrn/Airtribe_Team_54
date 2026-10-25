// "Then you send the message": a short, warm check-in text for a contact who
// is due a follow-up. Pure helpers (prompt, cleanup, template fallback) live
// here so they can be unit-tested; the LLM call is in draft-llm.ts.

export type DraftContact = {
  name: string;
  category: 'personal' | 'professional' | 'community';
  interests?: string[] | null;
  notes?: string | null;
  last_interaction_at?: string | null;
};

export type DraftInteraction = { occurred_at: string; type?: string | null; notes?: string | null };

export const MAX_DRAFT_CHARS = 320;

const TONE: Record<DraftContact['category'], string> = {
  personal: 'warm and casual, like a close friend or family member',
  professional: 'friendly but professional, like a colleague or mentor',
  community: 'friendly and light, like someone from a shared club or group',
};

function daysSince(iso: string | null | undefined, now: Date): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name.trim();

// WARNING: contact fields are user-entered and go into the prompt. They are the
// user's own data and the draft is only shown back to that user to copy, never
// sent, so injection can only affect their own suggestion.
export function buildDraftPrompt(c: DraftContact, recent: DraftInteraction[], now = new Date()): string {
  const days = daysSince(c.last_interaction_at, now);
  const facts = [
    `Name: ${c.name}`,
    `Relationship: ${c.category}`,
    c.interests?.length ? `Interests: ${c.interests.slice(0, 8).join(', ')}` : null,
    c.notes ? `Notes: ${c.notes.slice(0, 300)}` : null,
    days === null ? 'Last contact: unknown' : `Last contact: ${days} day${days === 1 ? '' : 's'} ago`,
    ...recent
      .slice(0, 3)
      .filter((i) => i.notes)
      .map((i) => `Earlier check-in note: ${String(i.notes).slice(0, 200)}`),
  ].filter(Boolean);
  return [
    'Write ONE short message the user can send to reconnect with this person.',
    `Tone: ${TONE[c.category]}. Indian English is fine. 1-3 sentences, under 280 characters.`,
    'Mention one specific interest or earlier note if there is one, and end with a light, concrete invitation (a call, coffee, or meeting up).',
    'No greeting card cliches, no emojis unless it is personal, no hashtags, no placeholders like [Name].',
    'Reply with the message text only - no quotes, no preamble.',
    '',
    ...facts,
  ].join('\n');
}

// The specific facts the suggestion was based on, shown beside the draft so the
// user can check the model did not invent anything. The draft is always
// editable and is never sent for the user.
export function draftBasis(c: DraftContact, recent: DraftInteraction[], now = new Date()): string[] {
  const days = daysSince(c.last_interaction_at, now);
  return [
    c.interests?.length ? `Interested in ${c.interests.slice(0, 8).join(', ')}` : null,
    c.notes ? `Your note: ${c.notes.slice(0, 300)}` : null,
    // A null date doesn't prove there was never a check-in (it can be cleared),
    // so say unknown, as the prompt does.
    days === null ? 'Last contact: unknown' : `Last contact: ${days} day${days === 1 ? '' : 's'} ago`,
    ...recent
      .slice(0, 3)
      .filter((i) => i.notes)
      .map((i) => `Earlier check-in: ${String(i.notes).slice(0, 200)}`),
  ].filter(Boolean) as string[];
}

// Strips wrapping quotes / "Message:" preambles and caps the length.
export function cleanDraft(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim().replace(/^(here(?:'s| is)|message|draft)[^:\n]*:\s*/i, '');
  s = s.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
  if (!s || /\[[^\]]*name[^\]]*\]/i.test(s)) return null;
  if (s.length > MAX_DRAFT_CHARS) {
    const cut = s.slice(0, MAX_DRAFT_CHARS);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
    s = end > 80 ? cut.slice(0, end + 1) : cut.trimEnd() + '…';
  }
  return s;
}

// What templateDraft actually reads - never claim notes or check-ins it ignores.
export function templateBasis(c: DraftContact): string[] {
  const interest = c.interests?.find((i) => i.trim());
  return [
    'Written from a template (no AI)',
    `Relationship: ${c.category}`,
    interest ? `Interested in ${interest}` : null,
  ].filter(Boolean) as string[];
}

// Used when no LLM key is set or every provider fails, so the button always works.
export function templateDraft(c: DraftContact): string {
  const name = firstName(c.name);
  const interest = c.interests?.find((i) => i.trim());
  const hook = interest ? ` Saw something about ${interest} and thought of you.` : '';
  if (c.category === 'professional') {
    return `Hi ${name}, hope work's treating you well!${hook} Would you be up for a quick catch-up call this week?`;
  }
  if (c.category === 'community') {
    return `Hey ${name}! It's been a while.${hook} Are you coming to the next meetup? Would be great to catch up.`;
  }
  return `Hey ${name}, I've been thinking about you.${hook} Are you free for a call or coffee this week?`;
}
