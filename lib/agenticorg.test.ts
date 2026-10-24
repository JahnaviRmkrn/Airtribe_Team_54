import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('./http', () => ({ HttpError: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
import { extractWithAgenticOrg } from './agenticorg';
const id = '45b5b4c7-dfbc-451a-a86a-ff2b9911e5ea';
const complete = { status: 'completed', confidence: 0.95, output: { contacts: [{ name: 'Priya', category: 'personal', preferred_frequency_days: 7 }], goals: { personal: 60, professional: 30, community: 30 } } };
beforeEach(() => { vi.stubEnv('AGENTICORG_API_KEY','test-key'); vi.stubEnv('AGENTICORG_AGENT_ID',id); vi.stubEnv('AGENTICORG_BASE_URL','https://agenticorg.hackathon.pinelabs.com'); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe('AgenticOrg extraction boundary', () => {
  it('calls the configured instance and normalizes completed output', async () => {
    const fetcher=vi.fn().mockResolvedValue(Response.json(complete)); vi.stubGlobal('fetch',fetcher);
    const result=await extractWithAgenticOrg('my sister Priya weekly');
    expect(result?.goals).toEqual({personal:50,professional:25,community:25});
    const [url,options]=fetcher.mock.calls[0];
    expect(String(url)).toBe(`https://agenticorg.hackathon.pinelabs.com/api/v1/agents/${id}/run`);
    expect(options.redirect).toBe('error');
    expect(JSON.parse(options.body).inputs).toEqual({transcript:'my sister Priya weekly'});
  });
  it.each(['hitl_triggered','pending_approval'])('does not accept %s even with plausible output', async status => {
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({...complete,status})));
    await expect(extractWithAgenticOrg('test')).rejects.toMatchObject({status:409});
  });
  it.each([
    {status:'failed',confidence:0.99,output:complete.output},
    {status:'completed',confidence:0.99,output:{}},
    {...complete,confidence:0.5},
    {...complete,output:{...complete.output,contacts:[{name:'Priya',category:'invented'}]}},
    {...complete,output:{...complete.output,goals:{personal:-5,professional:30,community:75}}},
  ])('rejects incomplete or uncertain results', async result => {
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json(result)));
    await expect(extractWithAgenticOrg('test')).rejects.toMatchObject({status:502});
  });
  it('makes no request when disabled',async()=>{
    vi.stubEnv('AGENTICORG_API_KEY','');vi.stubEnv('AGENTICORG_AGENT_ID','');
    const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    expect(await extractWithAgenticOrg('test')).toBeNull();expect(fetcher).not.toHaveBeenCalled();
  });
  it('fails incomplete configuration explicitly',async()=>{
    vi.stubEnv('AGENTICORG_API_KEY','');
    await expect(extractWithAgenticOrg('test')).rejects.toMatchObject({status:503});
  });
  it.each(['not-a-url','http://example.com','https://user:pass@example.com'])('rejects invalid server URL %s before sending a key',async url=>{
    vi.stubEnv('AGENTICORG_BASE_URL',url);
    const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    await expect(extractWithAgenticOrg('test')).rejects.toMatchObject({status:503});
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not leak credentials in upstream error messages',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('secret-key')));
    await expect(extractWithAgenticOrg('test')).rejects.toThrow('AgenticOrg is unavailable');
  });
});
