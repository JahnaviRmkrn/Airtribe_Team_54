import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
// The toolkit is mocked: tests never reach Pine Labs.
const execute = vi.hoisted(() => vi.fn());
vi.mock('@plural_pinelabs/agent-toolkit/shared', () => ({
  pinelabsEnvironment: { UAT: 'uat', PRODUCTION: 'prod' },
  PinelabsApiClient: vi.fn(),
  allToolDefinitions: ['createOrder', 'getOrder', 'cancelOrder'].map((name) => ({
    name,
    parameters: { parse: (a: unknown) => a },
    execute: (_client: unknown, args: unknown) => execute(name, args),
  })),
}));

const pl = await import('./pinelabs');

describe('amountPaise', () => {
  it('converts whole INR to paise', () => {
    expect(pl.amountPaise(450)).toBe(45000);
    expect(pl.amountPaise(1)).toBe(100);
  });

  it('returns null when there is no usable price', () => {
    for (const p of [null, undefined, 0, -10, 12.5, Number.NaN, Number.MAX_SAFE_INTEGER]) expect(pl.amountPaise(p)).toBeNull();
  });
});

describe('mapOrderStatus', () => {
  it.each([
    ['PROCESSED', 'paid'],
    ['PARTIALLY_REFUNDED', 'paid'],
    ['FAILED', 'failed'],
    ['CANCELLED', 'cancelled'],
    ['FULLY_REFUNDED', 'cancelled'],
    ['CREATED', 'pending'],
    ['PENDING', 'pending'],
    ['ATTEMPTED', 'pending'],
    ['AUTHORIZED', 'pending'],
    ['processed', 'paid'],
    ['SOMETHING_NEW', 'pending'],
    [undefined, 'pending'],
  ])('%s -> %s', (input, want) => {
    expect(pl.mapOrderStatus(input)).toBe(want);
  });
});

describe('toolkit calls', () => {
  beforeEach(() => {
    execute.mockReset();
    process.env.PINE_CLIENT_ID = 'id';
    process.env.PINE_CLIENT_SECRET = 'secret';
  });

  it('is not configured without credentials', async () => {
    delete process.env.PINE_CLIENT_SECRET;
    expect(pl.isConfigured()).toBe(false);
    await expect(pl.getOrderStatus('o1')).rejects.toMatchObject({ status: 503, message: 'Payments are not configured' });
  });

  it('createOrder sends the server-computed amount in INR paise', async () => {
    execute.mockResolvedValue(JSON.stringify({ token: 't', order_id: 'v1-1', redirect_url: 'https://pay/x', response_code: 200, response_message: 'ok' }));
    const r = await pl.createOrder({ amountPaise: 45000, merchantRef: 'ref-1', callbackUrl: 'https://app/m/tok?payment=done', guestName: 'Asha' });
    expect(r).toEqual({ orderId: 'v1-1', redirectUrl: 'https://pay/x' });
    expect(execute).toHaveBeenCalledWith('createOrder', {
      client_id: 'id',
      client_secret: 'secret',
      merchant_order_reference: 'ref-1',
      order_amount: { value: 45000, currency: 'INR' },
      callback_url: 'https://app/m/tok?payment=done',
      purchase_details: { customer: { first_name: 'Asha' } },
    });
  });

  it.each(['javascript:alert(1)', 'http://pay/checkout', 'https://user:password@pay/checkout'])('rejects unsafe checkout URL %s', async redirect_url => {
    execute.mockResolvedValue(JSON.stringify({order_id:'v1-1',redirect_url}));
    await expect(pl.createOrder({amountPaise:100,merchantRef:'ref',callbackUrl:'https://app/m/tok',guestName:'Asha'})).rejects.toMatchObject({status:502});
  });

  it('getOrderStatus maps the order status', async () => {
    execute.mockResolvedValue(JSON.stringify({ data: { order_id: 'v1-1', status: 'PROCESSED' } }));
    expect(await pl.getOrderStatus('v1-1')).toBe('paid');
    expect(execute).toHaveBeenCalledWith('getOrder', { order_id: 'v1-1' });
  });

  it('turns provider errors into a 502', async () => {
    execute.mockRejectedValue(new Error('Pinelabs API error (HTTP 500 GET /x)'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(pl.getOrderStatus('v1-1')).rejects.toMatchObject({ status: 502 });
  });
});
