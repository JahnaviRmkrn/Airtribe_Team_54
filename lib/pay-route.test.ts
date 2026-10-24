import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  results: [] as unknown[], createOrder: vi.fn(), getOrderStatus: vi.fn(), requireGuest: vi.fn(), update: vi.fn(),
}));
vi.mock('@/lib/http', () => ({
  handle: (fn: unknown) => fn,
  HttpError: class extends Error { constructor(public status: number, message: string) { super(message); } },
  ok: (body: unknown) => body,
}));
vi.mock('@/lib/pinelabs', () => ({
  isConfigured: () => true, amountPaise: (p: number) => p * 100,
  createOrder: mocks.createOrder, getOrderStatus: mocks.getOrderStatus,
}));
vi.mock('@/lib/ratelimit', () => ({ limitRoom: vi.fn() }));
vi.mock('@/lib/room', () => ({
  getRoom: async () => ({id:'room',final_venue_id:'venue',status:'open'}),
  requireGuest: mocks.requireGuest, requireOpen: vi.fn(),
}));
vi.mock('@/lib/urls', () => ({roomUrl: () => 'https://app/m/test'}));
vi.mock('@/lib/supabase/admin', () => ({ adminClient: () => ({ from: () => {
  const chain: Record<string, unknown> = {};
  for (const method of ['select','eq','is','insert']) chain[method] = () => chain;
  chain.update = (v: unknown) => { mocks.update(v); return chain; };
  chain.single = chain.maybeSingle = async () => mocks.results.shift();
  return chain;
} }) }));
const { GET, POST } = await import('../app/api/rooms/[token]/pay/route');
const req = new Request('https://app/api/rooms/test/pay');
const ctx = {params:Promise.resolve({token:'test'})};
const pending = {id:'payment',amount_paise:45000,pine_order_id:'order',redirect_url:'https://pay/checkout',status:'pending',updated_at:new Date().toISOString()};
beforeEach(() => {
  vi.clearAllMocks(); mocks.results=[];
  mocks.requireGuest.mockResolvedValue({id:'guest'});
  mocks.getOrderStatus.mockResolvedValue('pending');
});
describe('checkout server boundary', () => {
  it('reuses an already-paid payment without creating a new order', async () => {
    mocks.results=[{data:{price_per_person:450}},{data:{...pending,status:'paid'}}];
    await expect(POST(req,ctx)).resolves.toMatchObject({payment:{status:'paid',redirect_url:null}});
    expect(mocks.createOrder).not.toHaveBeenCalled();
  });
  it('preserves a pending order when the confirmed price differs', async () => {
    mocks.results=[{data:{price_per_person:500}},{data:pending}];
    await expect(POST(req,ctx)).rejects.toMatchObject({status:409});
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.createOrder).not.toHaveBeenCalled();
  });
  it('does not report paid when persisting provider status fails', async () => {
    mocks.getOrderStatus.mockResolvedValue('paid');
    mocks.results=[{data:pending},{data:null,error:{message:'database unavailable'}}];
    await expect(GET(req,ctx)).rejects.toMatchObject({status:503});
  });
  it('requires the guest identity before reading payments', async () => {
    mocks.requireGuest.mockRejectedValue(Object.assign(new Error('Join first'),{status:401}));
    await expect(GET(req,ctx)).rejects.toMatchObject({status:401});
    expect(mocks.getOrderStatus).not.toHaveBeenCalled();
  });
});
