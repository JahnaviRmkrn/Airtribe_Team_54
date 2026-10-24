import { z } from 'zod';

export const category = z.enum(['personal', 'professional', 'community']);
const isoDate = z.iso.datetime({ offset: true }).nullable();
const tags = z.array(z.string().trim().min(1).max(40)).max(20);

export const contactCreate = z.object({
  name: z.string().trim().min(1).max(120),
  category,
  interests: tags.default([]),
  notes: z.string().max(5000).nullable().optional(),
  preferred_frequency_days: z.number().int().min(1).max(365).nullable().optional(),
  last_interaction_at: isoDate.optional(),
  next_followup_at: isoDate.optional(),
});
export const contactUpdate = contactCreate.partial();
// Onboarding confirm step saves up to five contacts at once.
export const contactBulk = z.object({ contacts: z.array(contactCreate).min(1).max(5) });

export const goalsPut = z
  .object({
    personal: z.number().int().min(0).max(100),
    professional: z.number().int().min(0).max(100),
    community: z.number().int().min(0).max(100),
  })
  .refine((g) => g.personal + g.professional + g.community === 100, { message: 'Goals must total 100' });

export const interactionCreate = z.object({
  contact_id: z.uuid(),
  occurred_at: z.iso.datetime({ offset: true }).optional(),
  type: z.enum(['check_in', 'call', 'message', 'meetup', 'other']).default('check_in'),
  notes: z.string().max(2000).nullable().optional(),
  // Optionally move the contact's next follow-up in the same call.
  next_followup_at: isoDate.optional(),
});

export const meetupCreate = z.object({
  title: z.string().trim().min(1).max(120),
  activity: z.string().trim().min(1).max(40).default('dinner'),
  area: z.string().trim().max(80).nullable().optional(),
  starts_at: isoDate.optional(),
  budget: z.number().int().min(0).max(1_000_000).nullable().optional(),
});
export const meetupUpdate = meetupCreate.partial().extend({
  status: z.enum(['open', 'closed']).optional(),
  final_venue_id: z.uuid().nullable().optional(),
});

export const guestPreferences = z
  .object({
    budget_min: z.number().int().min(0).max(1_000_000).optional(),
    budget_max: z.number().int().min(0).max(1_000_000).optional(),
    area: z.string().trim().max(80).optional(),
    food: tags.optional(),
    activities: tags.optional(),
  })
  .strict();
const availability = z.array(z.string().trim().min(1).max(80)).max(20);

export const guestJoin = z.object({
  guest_name: z.string().trim().min(1).max(60),
  preferences: guestPreferences.default({}),
  availability: availability.default([]),
});
export const guestUpdate = guestJoin.partial();

export const voteBody = z.object({ venue_id: z.uuid() });
export const confirmBody = z.object({ venue_id: z.uuid() });
