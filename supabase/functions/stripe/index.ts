// Maison Moi billing: one Supabase Edge Function named "stripe" (deploy with "Verify JWT" turned off).
//   POST {action:'checkout', plan, return_url}  signed-in user -> Stripe Checkout link (plan 'monthly' or 'annual', 7-day trial the first time)
//   POST {action:'portal', return_url}    signed-in user -> Stripe billing portal link (change card, cancel, invoices)
//   POST from Stripe (stripe-signature)   webhook -> keeps public.subscriptions in step with Stripe
// Secrets (Supabase > Edge Functions > Secrets): STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET.
// Each plan uses its Stripe product's default price, so changing a price in Stripe needs no code change.
import Stripe from 'npm:stripe@17';
import { createClient } from 'npm:@supabase/supabase-js@2';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, { httpClient: Stripe.createFetchHttpClient() });
const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const TRIAL_DAYS = 7;
const PRODUCTS: Record<string, string> = { monthly: 'prod_VR8JTjDKiDATKq', annual: 'prod_VR8Jn1vupu8T2r' };
const HOME = 'https://maisonmoi.app/';
const RETURN_OK = ['https://maisonmoi.app', 'https://www.maisonmoi.app', 'https://justaproductgirl.github.io'];
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// Only send people back to Maison Moi itself (Stripe needs an https address, so the Mac's file:// copy goes to the live site).
function backTo(url?: string) {
  try { const u = new URL(url || ''); if (RETURN_OK.includes(u.origin)) return u.origin + u.pathname; } catch (_) { /* fall through */ }
  return HOME;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    if (req.headers.get('stripe-signature')) return await webhook(req);
    const { data: { user } } = await db.auth.getUser((req.headers.get('Authorization') || '').replace('Bearer ', ''));
    if (!user) return json({ error: 'Sign in first' }, 401);
    const { action, plan, return_url } = await req.json().catch(() => ({}));
    const back = backTo(return_url);
    const { data: sub } = await db.from('subscriptions').select('status,stripe_customer_id,trial_end').eq('user_id', user.id).maybeSingle();

    if (action === 'portal') {
      if (!sub?.stripe_customer_id) return json({ error: 'No subscription yet' }, 400);
      const s = await stripe.billingPortal.sessions.create({ customer: sub.stripe_customer_id, return_url: back });
      return json({ url: s.url });
    }
    if (action === 'checkout') {
      let customer = sub?.stripe_customer_id;
      if (!customer) {
        customer = (await stripe.customers.create({ email: user.email, metadata: { user_id: user.id } })).id;
        await db.from('subscriptions').upsert({ user_id: user.id, stripe_customer_id: customer, status: sub?.status || 'free', updated_at: new Date().toISOString() });
      }
      const product = await stripe.products.retrieve(PRODUCTS[plan] || PRODUCTS.monthly);
      const price = typeof product.default_price === 'string' ? product.default_price : product.default_price?.id;
      if (!price) return json({ error: 'That plan has no default price in Stripe' }, 500);
      const s = await stripe.checkout.sessions.create({
        mode: 'subscription', customer, client_reference_id: user.id,
        line_items: [{ price, quantity: 1 }],
        subscription_data: { metadata: { user_id: user.id }, ...(sub?.trial_end ? {} : { trial_period_days: TRIAL_DAYS }) }, // one free trial per account
        allow_promotion_codes: true,
        success_url: back + '?plus=welcome', cancel_url: back,
      });
      return json({ url: s.url });
    }
    return json({ error: 'Unknown action' }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error).message || e) }, 500);
  }
});

async function webhook(req: Request) {
  const event = await stripe.webhooks.constructEventAsync(await req.text(), req.headers.get('stripe-signature')!,
    Deno.env.get('STRIPE_WEBHOOK_SECRET')!, undefined, Stripe.createSubtleCryptoProvider());
  const o = event.data.object as any;
  if (event.type === 'checkout.session.completed' && o.subscription) await save(await stripe.subscriptions.retrieve(o.subscription), o.client_reference_id);
  if (event.type.startsWith('customer.subscription.')) await save(o);
  return json({ received: true });
}

const STATUS: Record<string, string> = { trialing: 'trialing', active: 'active', past_due: 'past_due', unpaid: 'past_due',
  canceled: 'canceled', incomplete_expired: 'canceled', paused: 'canceled', incomplete: 'free' };
const when = (t?: number | null) => (t ? new Date(t * 1000).toISOString() : null);

async function save(sub: any, userId?: string | null) {
  const customer = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
  let uid = userId || sub.metadata?.user_id;
  if (!uid) uid = (await db.from('subscriptions').select('user_id').eq('stripe_customer_id', customer).maybeSingle()).data?.user_id;
  if (!uid) return console.error('No Maison Moi account for Stripe customer', customer);
  const { data: now } = await db.from('subscriptions').select('status').eq('user_id', uid).maybeSingle();
  if (now?.status === 'comped') return; // founder passes are never overwritten by Stripe
  const item = sub.items?.data?.[0];
  const { error } = await db.from('subscriptions').upsert({
    user_id: uid, status: STATUS[sub.status] || 'free', stripe_customer_id: customer, stripe_subscription_id: sub.id,
    price_id: item?.price?.id || null, trial_end: when(sub.trial_end),
    current_period_end: when(sub.current_period_end ?? item?.current_period_end), // newer Stripe API versions keep it on the item
    cancel_at_period_end: !!sub.cancel_at_period_end, updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}
