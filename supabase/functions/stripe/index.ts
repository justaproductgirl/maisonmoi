// Maison Moi billing: one Supabase Edge Function named "stripe" (deploy with "Verify JWT" turned off).
//   POST {action:'prices'}                anyone -> each plan's current price ({monthly:{id,amount,interval}, annual:{...}}, amounts in cents)
//   POST {action:'checkout', plan, return_url}  signed-in user -> Stripe Checkout link (plan 'monthly' or 'annual', 7-day trial the first time);
//                                         refused with 409 if they already have Plus, so nobody pays twice
//   POST {action:'portal', return_url}    signed-in user -> Stripe billing portal link (change card, cancel, invoices)
//   POST {action:'delete_account'}        signed-in user -> deletes their Stripe customer (ending any subscription at once), photos and account
//   POST from Stripe (stripe-signature)   webhook -> keeps public.subscriptions in step with Stripe
// Secrets (Supabase > Edge Functions > Secrets): STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
// plus STRIPE_PRODUCT_MONTHLY, STRIPE_PRODUCT_ANNUAL and SITE_URL (the sandbox project points these at test products and sandbox.maisonmoi.app).
// Each plan uses its Stripe product's default price, so changing a price in Stripe needs no code change.
import Stripe from 'npm:stripe@17';
import { createClient } from 'npm:@supabase/supabase-js@2';

const env = (k: string) => (Deno.env.get(k) || '').trim(); // pasted secrets often pick up a stray space or newline
// Pinned to the webhook's API version; Managed Payments (Stripe as seller of record) needs 2025-03-31 or later.
// The placeholder lets the function start on a project with no Stripe key yet (Stripe calls then fail, account deletion still works).
const stripe = new Stripe(env('STRIPE_SECRET_KEY') || 'no_key_set', { apiVersion: '2026-09-30.endive' as any, httpClient: Stripe.createFetchHttpClient() });
// Server-side key: the classic service role key, or the newer sb_secret_ key on projects that use the new key system.
const serverKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}').default;
const db = createClient(Deno.env.get('SUPABASE_URL')!, serverKey);
const TRIAL_DAYS = 7;
const PRODUCTS: Record<string, string> = { monthly: env('STRIPE_PRODUCT_MONTHLY') || 'prod_VR8JTjDKiDATKq', annual: env('STRIPE_PRODUCT_ANNUAL') || 'prod_VR8Jn1vupu8T2r' };
const HOME = env('SITE_URL') || 'https://maisonmoi.app/';
const RETURN_OK = ['https://maisonmoi.app', 'https://www.maisonmoi.app', 'https://justaproductgirl.github.io', 'https://sandbox.maisonmoi.app', 'http://localhost:8000'];
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const LIVE = ['trialing', 'active', 'past_due', 'comped'];                 // our statuses that mean "already has Plus"
const STRIPE_LIVE = ['trialing', 'active', 'past_due', 'unpaid', 'paused']; // Stripe statuses that can still bill or resume
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
    const { action, plan, return_url } = await req.json().catch(() => ({}));
    if (action === 'prices') return json(await prices());
    const { data: { user } } = await db.auth.getUser((req.headers.get('Authorization') || '').replace('Bearer ', ''));
    if (!user) return json({ error: 'Sign in first' }, 401);
    const back = backTo(return_url);
    const { data: sub } = await db.from('subscriptions').select('status,stripe_customer_id,trial_end').eq('user_id', user.id).maybeSingle();

    if (action === 'portal') {
      if (!sub?.stripe_customer_id) return json({ error: 'No subscription yet' }, 400);
      const s = await stripe.billingPortal.sessions.create({ customer: sub.stripe_customer_id, return_url: back });
      return json({ url: s.url });
    }
    if (action === 'checkout') {
      const already = { error: 'You already have Maison Moi Plus. Use Manage subscription to change your plan.', code: 'already_plus' };
      if (LIVE.includes(sub?.status || '')) return json(already, 409);
      let customer = sub?.stripe_customer_id;
      if (customer) { // our table can lag behind Stripe (a webhook still on its way), so ask Stripe too
        const open = await stripe.subscriptions.list({ customer, status: 'all', limit: 20 });
        const live = open.data.find((x) => STRIPE_LIVE.includes(x.status));
        if (live) { await save(live, user.id); return json(already, 409); }
      }
      if (!customer) {
        customer = (await stripe.customers.create({ email: user.email, metadata: { user_id: user.id } })).id;
        await db.from('subscriptions').upsert({ user_id: user.id, stripe_customer_id: customer, status: sub?.status || 'free', updated_at: new Date().toISOString() });
      }
      const price = (await prices())[plan === 'annual' ? 'annual' : 'monthly']?.id;
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
    if (action === 'delete_account') {
      // Deleting the Stripe customer cancels any subscription immediately, so nothing more is ever charged.
      if (sub?.stripe_customer_id) {
        try { await stripe.customers.del(sub.stripe_customer_id); }
        catch (e) { if ((e as any)?.code !== 'resource_missing') throw e; }
      }
      const bucket = db.storage.from('closet-photos');
      for (let round = 0; round < 50; round++) { // 1,000 photos per round
        const { data: files, error } = await bucket.list(user.id, { limit: 1000 });
        if (error) throw error;
        const paths = (files || []).filter((f) => f.id).map((f) => `${user.id}/${f.name}`);
        if (!paths.length) break;
        const { error: gone } = await bucket.remove(paths);
        if (gone) throw gone;
      }
      const { error } = await db.auth.admin.deleteUser(user.id); // profiles, items, closet_state and subscriptions go with it
      if (error) throw error;
      return json({ deleted: true });
    }
    return json({ error: 'Unknown action' }, 400);
  } catch (e) {
    console.error(e); // the details stay in the function logs; people see a plain message
    return json({ error: 'Something went wrong on our side. Please try again in a minute.' }, 500);
  }
});

// Each plan's default price, remembered for 10 minutes so the Upgrade page doesn't call Stripe on every visit.
let priceCache: { at: number; data: Record<string, { id: string; amount: number; interval: string } | null> } | null = null;
async function prices() {
  if (priceCache && Date.now() - priceCache.at < 10 * 60e3) return priceCache.data;
  const data: Record<string, { id: string; amount: number; interval: string } | null> = {};
  for (const [plan, id] of Object.entries(PRODUCTS)) {
    const product = await stripe.products.retrieve(id, { expand: ['default_price'] });
    const p = product.default_price as any;
    data[plan] = p?.id ? { id: p.id, amount: p.unit_amount, interval: p.recurring?.interval || '' } : null;
  }
  priceCache = { at: Date.now(), data };
  return data;
}

async function webhook(req: Request) {
  const event = await stripe.webhooks.constructEventAsync(await req.text(), req.headers.get('stripe-signature')!,
    env('STRIPE_WEBHOOK_SECRET'), undefined, Stripe.createSubtleCryptoProvider());
  const o = event.data.object as any;
  // Stripe doesn't promise to deliver events in order, so never trust the copy inside the event: fetch the subscription's
  // state right now. A late "created" event then can't undo a newer "active", and replays are harmless.
  const id = event.type === 'checkout.session.completed' ? o.subscription : event.type.startsWith('customer.subscription.') ? o.id : null;
  if (!id) return json({ received: true });
  let sub;
  try { sub = await stripe.subscriptions.retrieve(id); }
  catch (e) { if ((e as any)?.code !== 'resource_missing' || o.object !== 'subscription') throw e; sub = o; } // gone with a deleted customer
  await save(sub, o.client_reference_id || o.metadata?.user_id);
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
  const { data: now } = await db.from('subscriptions').select('status,stripe_subscription_id').eq('user_id', uid).maybeSingle();
  if (now?.status === 'comped') return; // founder passes are never overwritten by Stripe
  // Someone with two subscriptions (an old canceled one and a new one): news about the old one must not end the new one.
  if (now?.stripe_subscription_id && now.stripe_subscription_id !== sub.id && LIVE.includes(now.status) && !STRIPE_LIVE.includes(sub.status)) return;
  const item = sub.items?.data?.[0];
  const { error } = await db.from('subscriptions').upsert({
    user_id: uid, status: STATUS[sub.status] || 'free', stripe_customer_id: customer, stripe_subscription_id: sub.id,
    price_id: item?.price?.id || null, trial_end: when(sub.trial_end),
    current_period_end: when(sub.current_period_end ?? item?.current_period_end), // newer Stripe API versions keep it on the item
    cancel_at_period_end: !!sub.cancel_at_period_end, updated_at: new Date().toISOString(),
  });
  if (error?.code === '23503') return console.warn('Account already deleted, skipping Stripe update for', uid); // late events after a deletion
  if (error) throw error;
}
