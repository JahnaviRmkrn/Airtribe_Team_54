import 'server-only';
import { z } from 'zod';
import { clean, type ExtractResult } from './extract';
import { HttpError } from './http';

// Contract: AgenticOrg SDK 0.4.0 AgentsResource.run(UUID), POST /agents/{id}/run.
// Target identity is server configuration, never taken from model/user input.
const resultSchema = z.object({
  status: z.literal('completed'),
  confidence: z.number().finite().min(0.88).max(1),
  output: z.object({
    contacts: z.array(z.object({
      name: z.string().trim().min(1),
      category: z.enum(['personal', 'professional', 'community']),
      interests: z.array(z.string()).optional(),
      preferred_frequency_days: z.number().int().positive().optional(),
    })).max(5),
    goals: z.object({
      personal: z.number().finite().nonnegative(),
      professional: z.number().finite().nonnegative(),
      community: z.number().finite().nonnegative(),
    }),
  }),
});

export async function extractWithAgenticOrg(transcript: string): Promise<ExtractResult | null> {
  const key = process.env.AGENTICORG_API_KEY;
  const agentId = process.env.AGENTICORG_AGENT_ID;
  if (!key && !agentId) return null;
  if (!key || !agentId) throw new HttpError(503, 'AgenticOrg configuration is incomplete');
  if (!z.uuid().safeParse(agentId).success) throw new HttpError(503, 'AgenticOrg agent configuration is invalid');
  let base: URL;
  try {
    base = new URL(process.env.AGENTICORG_BASE_URL || 'https://agenticorg.hackathon.pinelabs.com');
  } catch {
    throw new HttpError(503, 'AgenticOrg server URL is invalid');
  }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw new HttpError(503, 'AgenticOrg requires a secure server-configured URL');
  }
  let response: Response;
  try {
    response = await fetch(new URL(`/api/v1/agents/${agentId}/run`, base), {
      method: 'POST', redirect: 'error', cache: 'no-store',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'extract_onboarding', inputs: { transcript }, context: {} }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new HttpError(502, 'AgenticOrg is unavailable; enter your draft manually or retry');
  }
  if (!response.ok) throw new HttpError(502, 'AgenticOrg could not complete extraction');
  const raw = await response.json().catch(() => null);
  // Never route a pending human approval through another model to evade it.
  if (raw?.status === 'hitl_triggered' || raw?.status === 'pending_approval') {
    throw new HttpError(409, 'AgenticOrg requires human review; no draft was applied');
  }
  const parsed = resultSchema.safeParse(raw);
  if (!parsed.success) throw new HttpError(502, 'AgenticOrg did not return a validated completed draft');
  return clean(parsed.data.output);
}
