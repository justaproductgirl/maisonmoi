// Maison Moi contact form: checks the visitor isn't a bot, then emails the message to hello@maisonmoi.app.
// Deploy with Verify JWT off (visitors don't need an account). Secrets: TURNSTILE_SECRET, SMTP_USER, SMTP_PASS
// (a Google Workspace app password). Edge functions can't use ports 25 or 587, so mail goes over 465.
import nodemailer from 'npm:nodemailer@6';

const env = (k: string) => (Deno.env.get(k) || '').trim(); // pasted secrets often pick up a stray space or newline
const TO = env('CONTACT_TO') || 'hello@maisonmoi.app';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const clean = (v: unknown, max: number) => String(v ?? '').replace(/\r/g, '').trim().slice(0, max);
const oneLine = (v: string) => v.replace(/[\n\t]+/g, ' '); // keeps names and subjects out of email headers' way

const mailer = nodemailer.createTransport({
  host: 'smtp.gmail.com', port: 465, secure: true,
  auth: { user: env('SMTP_USER'), pass: env('SMTP_PASS') },
});

async function human(token: string, ip: string) {
  if (!env('TURNSTILE_SECRET')) return false;
  const form = new FormData();
  form.append('secret', env('TURNSTILE_SECRET'));
  form.append('response', token);
  if (ip) form.append('remoteip', ip);
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
  const out = await r.json().catch(() => ({}));
  return out.success === true;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    if (body.website) return json({ ok: true }); // hidden field only bots fill in: pretend it worked
    const name = oneLine(clean(body.name, 100));
    const email = oneLine(clean(body.email, 200));
    const topic = oneLine(clean(body.topic, 60)) || 'General';
    const message = clean(body.message, 5000);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'Please enter a valid email so we can reply.' }, 400);
    if (message.length < 2) return json({ error: 'Please write a message.' }, 400);
    const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim();
    if (!(await human(clean(body.token, 2048), ip))) return json({ error: "We couldn't confirm you're not a bot. Refresh the page and try again." }, 403);

    await mailer.sendMail({
      from: { name: 'Maison Moi', address: env('SMTP_USER') },
      to: TO,
      replyTo: { name: name || email, address: email },
      subject: `Contact: ${topic}${name ? ' from ' + name : ''}`,
      text: `From: ${name || '(no name)'} <${email}>\nTopic: ${topic}\nSent: ${new Date().toISOString()}\n\n${message}\n`,
    });
    return json({ ok: true });
  } catch (e) {
    console.error('contact', e);
    return json({ error: "Your message didn't send. Please try again in a minute, or email hello@maisonmoi.app." }, 500);
  }
});
