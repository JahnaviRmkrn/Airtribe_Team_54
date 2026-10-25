import 'server-only';
import { randomUUID } from 'node:crypto';
import { HttpError } from '../http';
import { adminClient } from '../supabase/admin';
import { seal, unseal, type GoogleConfig, type Session } from './connector';
import { previewHash, type ActionPreview } from './action-content';
import type { ProviderOutcome } from './action-provider';

export interface StoredAction {
  id: string; user_id: string; purpose: string; session_id: string; preview_hash: string; encrypted_preview: string | null;
  state: 'preview' | 'claimed' | 'completed' | 'uncertain' | 'rejected' | 'cancelled' | 'expired';
  provider_ref: string | null; expires_at: string; created_at: string;
}
const table = 'google_confirmed_actions';
const storageError = () => new HttpError(503, 'Could not verify the saved action. No repeat action will be attempted. Check its status before doing anything else.');
export async function loadAction(config: GoogleConfig, owner: string, id: string): Promise<StoredAction> {
  const { data, error } = await adminClient().from(table).select('*').eq('id', id).eq('user_id', owner).eq('purpose', config.purpose).maybeSingle();
  if (error) throw storageError();
  if (!data) throw new HttpError(404, 'This action was not found.');
  return data;
}
export async function recentActions(config: GoogleConfig, owner: string): Promise<StoredAction[]> {
  const { data, error } = await adminClient().from(table).select('*').eq('user_id', owner).eq('purpose', config.purpose).order('created_at', { ascending: false }).limit(10);
  if (error) throw storageError();
  return data || [];
}
export function contentForAction(config: GoogleConfig, row: StoredAction) {
  if (!row.encrypted_preview) throw new HttpError(410, 'This preview has expired. Its action history still prevents replay.');
  const preview = unseal<ActionPreview>(row.encrypted_preview, config, row.id, row.user_id);
  if (preview.kind !== config.purpose || previewHash(preview) !== row.preview_hash) throw storageError();
  return preview;
}
export function actionView(config: GoogleConfig, row: StoredAction) {
  return { id: row.id, purpose: row.purpose, previewHash: row.preview_hash,
    state: row.state === 'preview' && Date.parse(row.expires_at) <= Date.now() ? 'expired' : row.state,
    expiresAt: row.expires_at, createdAt: row.created_at,
    preview: row.encrypted_preview ? contentForAction(config, row) : null,
    providerRef: row.provider_ref,
  };
}
export async function storePreview(config: GoogleConfig, session: Session<unknown>, preview: ActionPreview) {
  const id = randomUUID();
  const { data, error } = await adminClient().rpc('create_google_action_preview', {
    p_id: id, p_owner: session.owner, p_purpose: config.purpose, p_session: session.id, p_lease: session.lease,
    p_hash: previewHash(preview), p_preview: seal(preview, config, id, session.owner),
  });
  if (error || !data?.[0]) throw storageError();
  return data[0] as StoredAction;
}
export async function claimAction(config: GoogleConfig, session: Session<unknown>, id: string, hash: string) {
  const { data, error } = await adminClient().rpc('claim_google_confirmed_action', {
    p_id: id, p_owner: session.owner, p_purpose: config.purpose, p_session: session.id, p_lease: session.lease, p_hash: hash,
  });
  // RPC failure may mean the claim committed. Never send without returned proof.
  if (error) throw storageError();
  return (data?.[0] as StoredAction | undefined) || null;
}
export async function finishAction(config: GoogleConfig, owner: string, id: string, outcome: ProviderOutcome) {
  const { data, error } = await adminClient().from(table).update({ state: outcome.state, provider_ref: outcome.providerRef || null, finished_at: new Date().toISOString() })
    .eq('id', id).eq('user_id', owner).eq('purpose', config.purpose).in('state', outcome.state === 'completed' ? ['claimed', 'uncertain'] : ['claimed']).select('id');
  if (error || !data?.length) throw storageError();
}
export async function cancelAction(config: GoogleConfig, owner: string, id: string) {
  const { error } = await adminClient().from(table).update({ state: 'cancelled', finished_at: new Date().toISOString() })
    .eq('id', id).eq('user_id', owner).eq('purpose', config.purpose).eq('state', 'preview');
  if (error) throw storageError();
  return loadAction(config, owner, id);
}
