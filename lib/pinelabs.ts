import 'server-only';
import { allToolDefinitions, PinelabsApiClient, pinelabsEnvironment } from '@plural_pinelabs/agent-toolkit/shared';
import { HttpError } from './http';

// Pine Labs Online checkout via the Pine Labs Agent Toolkit. Its tools are
// called directly server-side (no LLM). The `/openai` entry imports
// `@openai/agents` at load time, so this uses the toolkit's `/shared` tool
// registry with the same lookup + parse + execute as its handleToolCall().
// WARNING: PINE_CLIENT_SECRET is server-only; never expose it or send it to the browser.

export type PaymentStatus = 'pending' | 'paid' | 'failed' | 'cancelled';

type Toolkit = { handleToolCall(name: string, args: unknown): Promise<string> };
let toolkit: Toolkit | null = null;

const creds = () => ({ id: process.env.PINE_CLIENT_ID?.trim(), secret: process.env.PINE_CLIENT_SECRET?.trim() });
export const isConfigured = () => Boolean(creds().id && creds().secret);

function getToolkit(): Toolkit {
  if (!isConfigured()) throw new HttpError(503, 'Payments are not configured');
  if (!toolkit) {
    const env = process.env.PINE_ENV === 'production' ? pinelabsEnvironment.PRODUCTION : pinelabsEnvironment.UAT;
    const client = new PinelabsApiClient(env, creds().id!, creds().secret!);
    toolkit = {
      async handleToolCall(name, args) {
        const def = allToolDefinitions.find((d) => d.name === name);
        if (!def) throw new Error(`Unknown tool: ${name}`);
        return def.execute(client, def.parameters.parse(args));
      },
    };
  }
  return toolkit;
}

// Pine Labs bills in paise; venue prices are whole INR. null when there is no usable price.
export function amountPaise(pricePerPerson: number | null | undefined): number | null {
  if (typeof pricePerPerson !== 'number' || !Number.isInteger(pricePerPerson) || pricePerPerson <= 0) return null;
  return pricePerPerson * 100;
}

// Pine Labs order statuses -> ours. Unknown or in-flight states stay pending.
// AUTHORIZED is not captured money (we never pre-auth), so it is not "paid".
export function mapOrderStatus(status: string | null | undefined): PaymentStatus {
  switch ((status ?? '').toUpperCase()) {
    case 'PROCESSED':
    case 'PARTIALLY_REFUNDED':
      return 'paid';
    case 'FAILED':
      return 'failed';
    case 'CANCELLED':
    case 'FULLY_REFUNDED':
      return 'cancelled';
    default:
      return 'pending';
  }
}

async function call(name: string, args: unknown): Promise<Record<string, unknown>> {
  const tk = getToolkit();
  try {
    return JSON.parse(await tk.handleToolCall(name, args));
  } catch (e) {
    // Log the tool error, never the args (they include the client secret).
    console.error(`Pine Labs ${name} failed:`, e instanceof Error ? e.message : e);
    throw new HttpError(502, 'Payment provider error, please retry');
  }
}

export async function createOrder(o: { amountPaise: number; merchantRef: string; callbackUrl: string; guestName: string }) {
  const { id, secret } = creds();
  const res = await call('createOrder', {
    client_id: id,
    client_secret: secret,
    merchant_order_reference: o.merchantRef,
    order_amount: { value: o.amountPaise, currency: 'INR' },
    callback_url: o.callbackUrl,
    purchase_details: { customer: { first_name: o.guestName } },
  });
  if (typeof res.order_id !== 'string' || typeof res.redirect_url !== 'string') {
    throw new HttpError(502, 'Payment provider error, please retry');
  }
  return { orderId: res.order_id, redirectUrl: res.redirect_url };
}

export async function getOrderStatus(orderId: string): Promise<PaymentStatus> {
  const res = await call('getOrder', { order_id: orderId });
  return mapOrderStatus((res.data as { status?: string } | undefined)?.status);
}

// Best effort: an order superseded by a new amount should not stay payable.
export async function cancelOrder(orderId: string) {
  await call('cancelOrder', { order_id: orderId }).catch(() => undefined);
}
