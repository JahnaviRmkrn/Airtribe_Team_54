import { describe, expect, it } from 'vitest';
import { duplicateMigrationVersions, trackedEnvFiles } from '../scripts/check-repo.mjs';

describe('tracked environment file guard', () => {
  it('rejects local and nested environment files without reading values', () => {
    expect(trackedEnvFiles(['.env', '.env.local', '.env.production', 'nested/.env.local', '.env.example', 'nested/.env.example', 'lib/env.ts']))
      .toEqual(['.env', '.env.local', '.env.production', 'nested/.env.local']);
  });
});

describe('migration version guard', () => {
  it('rejects different migration names sharing one version', () => {
    const paths = ['supabase/migrations/20261025120000_contact_create_intents.sql',
      'supabase/migrations/20261025120000_payment_attempt_receipts.sql'];
    expect(duplicateMigrationVersions(paths)).toEqual([{ version: '20261025120000', paths }]);
  });
  it('allows independent versions and ignores unrelated SQL paths', () => {
    expect(duplicateMigrationVersions(['supabase/migrations/20261025120000_payment_attempt_receipts.sql',
      'supabase/migrations/20261025121000_contact_create_intents.sql',
      'tests/20261025120000_fixture.sql', 'supabase/seed.sql'])).toEqual([]);
  });
  it('reports every collision deterministically without reading SQL contents', () => {
    expect(duplicateMigrationVersions(['supabase/migrations/2_b.sql', 'supabase/migrations/1_b.sql',
      'supabase/migrations/2_a.sql', 'supabase/migrations/1_a.sql'])).toEqual([
      { version: '1', paths: ['supabase/migrations/1_a.sql', 'supabase/migrations/1_b.sql'] },
      { version: '2', paths: ['supabase/migrations/2_a.sql', 'supabase/migrations/2_b.sql'] },
    ]);
  });
});
