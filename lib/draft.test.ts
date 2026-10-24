import { describe, expect, it } from 'vitest';
import { buildDraftPrompt, cleanDraft, draftBasis, MAX_DRAFT_CHARS, templateDraft, type DraftContact } from './draft';

const meera: DraftContact = {
  name: 'Meera Iyer',
  category: 'personal',
  interests: ['trekking', 'filter coffee'],
  notes: 'Moved to Pune in June',
  last_interaction_at: '2026-10-04T10:00:00+05:30',
};

describe('buildDraftPrompt', () => {
  it('includes the facts the model should use', () => {
    const p = buildDraftPrompt(meera, [{ occurred_at: '2026-10-04', notes: 'Talked about her new job' }], new Date('2026-10-24T10:00:00+05:30'));
    expect(p).toContain('Name: Meera Iyer');
    expect(p).toContain('Interests: trekking, filter coffee');
    expect(p).toContain('Last contact: 20 days ago');
    expect(p).toContain('Earlier check-in note: Talked about her new job');
    expect(p).toMatch(/warm and casual/);
  });

  it('copes with a bare contact', () => {
    const p = buildDraftPrompt({ name: 'Rahul', category: 'professional' }, []);
    expect(p).toContain('Last contact: unknown');
    expect(p).toMatch(/professional/);
    expect(p).not.toContain('Interests:');
  });
});

describe('draftBasis', () => {
  it('lists the facts the suggestion is based on', () => {
    const basis = draftBasis(meera, [{ occurred_at: '2026-10-04', notes: 'Talked about her new job' }], new Date('2026-10-24T10:00:00+05:30'));
    expect(basis).toContain('Interested in trekking, filter coffee');
    expect(basis).toContain('Your note: Moved to Pune in June');
    expect(basis).toContain('Last contact: 20 days ago');
    expect(basis).toContain('Earlier check-in: Talked about her new job');
  });

  it('keeps unknown facts out instead of inventing them', () => {
    const basis = draftBasis({ name: 'Rahul', category: 'professional' }, []);
    expect(basis).toEqual(['No check-in logged yet']);
  });
});

describe('cleanDraft', () => {
  it('strips quotes and preambles', () => {
    expect(cleanDraft('Here is a message: "Hey Meera, coffee this week?"')).toBe('Hey Meera, coffee this week?');
    expect(cleanDraft('“Hi Rahul!”')).toBe('Hi Rahul!');
  });

  it('rejects empty output and placeholders', () => {
    expect(cleanDraft('')).toBeNull();
    expect(cleanDraft(undefined)).toBeNull();
    expect(cleanDraft('Hey [Name], long time!')).toBeNull();
  });

  it('caps long output at a sentence boundary', () => {
    const long = 'Hey Meera, it has been a while since we last spoke about everything going on. '.repeat(8);
    const out = cleanDraft(long)!;
    expect(out.length).toBeLessThanOrEqual(MAX_DRAFT_CHARS + 1);
    expect(out.endsWith('.') || out.endsWith('…')).toBe(true);
  });
});

describe('templateDraft', () => {
  it('uses the first name and an interest', () => {
    const t = templateDraft(meera);
    expect(t.startsWith('Hey Meera,')).toBe(true);
    expect(t).toContain('trekking');
  });

  it('adapts to the relationship', () => {
    expect(templateDraft({ name: 'Rahul Shah', category: 'professional' })).toMatch(/^Hi Rahul, .*call/);
    expect(templateDraft({ name: 'Sana', category: 'community' })).toMatch(/meetup/);
  });
});
