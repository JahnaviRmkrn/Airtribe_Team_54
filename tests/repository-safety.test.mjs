import { describe, expect, it } from 'vitest';
import { trackedEnvFiles } from '../scripts/check-repo.mjs';

describe('tracked environment file guard', () => {
  it('rejects local and nested environment files without reading values', () => {
    expect(trackedEnvFiles(['.env', '.env.local', '.env.production', 'nested/.env.local', '.env.example', 'nested/.env.example', 'lib/env.ts']))
      .toEqual(['.env', '.env.local', '.env.production', 'nested/.env.local']);
  });
});
