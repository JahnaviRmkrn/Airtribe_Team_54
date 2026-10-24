import { z } from 'zod';

export const category = z.enum(['personal', 'professional', 'community']);
const isoDate = z.iso.datetime({ offset: true }).nullable();
const tags = z.array(z.string().trim().min(1).max(40)).max(20);

// Base shapes have no defaults: Zod 4 keeps defaults through .partial(), which
// would make a PATCH overwrite omitted fields. Defaults live on create only.
const contactBase = z.object({
  name: z.string().trim().min(1).max(120),
  category,
  interests: tags,
  notes: z.string().max(5000).nullable(),
  email: z.email().max(254).nullable(),
  preferred_frequency_days: z.number().int().min(1).max(365).nullable(),
  last_interaction_at: isoDate,
  next_followup_at: isoDate,
});
export const contactCreate = contactBase.partial().required({ name: true, category: true }).extend({
  interests: tags.default([]),
});
export const contactUpdate = contactBase.partial();
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

const meetupBase = z.object({
  title: z.string().trim().min(1).max(120),
  activity: z.string().trim().min(1).max(40),
  area: z.string().trim().max(80).nullable(),
  starts_at: isoDate,
  budget: z.number().int().min(0).max(1_000_000).nullable(),
  notes: z.string().trim().max(2000).nullable(),
});
export const meetupCreate = meetupBase.partial().required({ title: true }).extend({
  activity: meetupBase.shape.activity.default('dinner'),
});
export const meetupUpdate = meetupBase.partial().extend({
  status: z.enum(['open', 'closed']).optional(),
  final_venue_id: z.uuid().nullable().optional(),
});

export const guestPreferences = z
  .object({
    budget_min: z.number().int().min(0).max(1_000_000).optional(),
    budget_max: z.number().int().min(0).max(1_000_000).optional(),
    area: z.string().trim().max(80).optional(),
    // "Meet in the middle": where this guest is coming from. Rounded to 3
    // decimals (~110 m) before storage; other guests only ever see ~1 km.
    location: z
      .object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), label: z.string().trim().max(80).optional() })
      .strict()
      .transform((l) => ({ ...l, lat: Math.round(l.lat * 1000) / 1000, lng: Math.round(l.lng * 1000) / 1000 }))
      .nullable() // null = stop sharing; omitted on PATCH = keep what's stored
      .optional(),
    food: tags.optional(),
    activities: tags.optional(),
  })
  .strict();
const availability = z.array(z.string().trim().min(1).max(80)).max(20);

const guestBase = z.object({
  guest_name: z.string().trim().min(1).max(60),
  preferences: guestPreferences,
  availability,
});
export const guestJoin = guestBase.extend({
  preferences: guestPreferences.default({}),
  availability: availability.default([]),
});
export const guestUpdate = guestBase.partial();

export const voteBody = z.object({ venue_id: z.uuid() });
export const confirmBody = z.object({ venue_id: z.uuid() });
