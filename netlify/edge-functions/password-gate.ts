/**
 * Single-password gate for the whole site.
 *
 * The preview renders real donor names, email addresses, and gift amounts, so it
 * must never be openly reachable. Netlify sites are public by default and its
 * built-in password protection is a paid-plan feature, so this runs at the edge
 * on any plan.
 *
 * Deliberately NOT HTTP Basic Auth: that always renders a username field the
 * viewer has to guess at or leave blank. This serves a form with one field.
 *
 * Set in Netlify → Site configuration → Environment variables:
 *   PREVIEW_PASSWORD
 *
 * Fails CLOSED. Without PREVIEW_PASSWORD the site locks rather than opens — a
 * misconfiguration should cost access, not donor privacy.
 *
 * The password lives in the environment, never the repo: a shared secret
 * guarding donor data must not sit in git history.
 */

const COOKIE = 'overflow_preview';
const LOGIN_PATH = '/__preview-login';
const MAX_AGE = 60 * 60 * 24 * 14; // 14 days

/**
 * Session token derived from the password. Recomputed and compared on each
 * request, so a cookie cannot be forged without knowing the password itself.
 */
async function tokenFor(password: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('overflow-preview-v1'));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Comparison whose timing does not depend on how much of the value matched. */
function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

function loginPage(next: string, error: boolean, locked: boolean): Response {
  const body = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Overflow preview</title>
<style>
  :root{color-scheme:light;--plane:#f9f9f7;--surface:#fcfcfb;--ink:#0b0b0b;--ink-2:#52514e;
        --hairline:rgba(11,11,11,.10);--series:#2a78d6;--critical:#d03b3b}
  @media (prefers-color-scheme:dark){:root{color-scheme:dark;--plane:#0d0d0d;--surface:#1a1a19;
        --ink:#fff;--ink-2:#c3c2b7;--hairline:rgba(255,255,255,.10);--series:#3987e5}}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;
       background:var(--plane);color:var(--ink);
       font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
  form{width:100%;max-width:22rem;background:var(--surface);border:1px solid var(--hairline);
       border-radius:12px;padding:24px}
  h1{margin:0 0 4px;font-size:1.05rem}
  p{margin:0 0 18px;font-size:.85rem;line-height:1.5;color:var(--ink-2)}
  label{display:block;font-size:.8rem;font-weight:600;margin-bottom:6px}
  input{width:100%;padding:10px 12px;font-size:1rem;border-radius:8px;
        border:1px solid var(--hairline);background:var(--plane);color:var(--ink)}
  input:focus{outline:2px solid var(--series);outline-offset:1px}
  button{width:100%;margin-top:14px;padding:10px 12px;font-size:.95rem;font-weight:600;
         border:0;border-radius:8px;background:var(--series);color:#fff;cursor:pointer}
  .err{margin:12px 0 0;font-size:.85rem;color:var(--critical)}
</style></head><body>
<form method="POST" action="${LOGIN_PATH}">
  <h1>Overflow → MinistryPlatform</h1>
  <p>${
    locked
      ? 'This preview is locked: no password is configured for the site.'
      : 'This page contains giving data. Enter the password to continue.'
  }</p>
  ${
    locked
      ? ''
      : `<label for="p">Password</label>
  <input id="p" name="password" type="password" autocomplete="current-password" autofocus required>
  <input type="hidden" name="next" value="${next.replace(/"/g, '&quot;')}">
  <button type="submit">View preview</button>`
  }
  ${error ? '<p class="err">Incorrect password.</p>' : ''}
</form></body></html>`;

  return new Response(body, {
    status: locked ? 503 : 401,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, private',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}

export default async function handler(request: Request): Promise<Response | void> {
  const password = Deno.env.get('PREVIEW_PASSWORD');
  const url = new URL(request.url);

  if (!password) return loginPage('/', false, true);

  const expected = await tokenFor(password);

  // Submitted the form.
  if (url.pathname === LOGIN_PATH && request.method === 'POST') {
    const form = await request.formData();
    const supplied = String(form.get('password') ?? '');
    // Only same-origin relative paths, so the form can't be used as an open redirect.
    const raw = String(form.get('next') ?? '/');
    const next = raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';

    if (!safeEqual(supplied, password)) return loginPage(next, true, false);

    return new Response(null, {
      status: 303,
      headers: {
        Location: next,
        'Cache-Control': 'no-store, private',
        'Set-Cookie':
          `${COOKIE}=${expected}; Path=/; Max-Age=${MAX_AGE}; ` +
          `HttpOnly; Secure; SameSite=Lax`,
      },
    });
  }

  // Already signed in.
  const cookie = readCookie(request.headers.get('cookie'), COOKIE);
  if (cookie && safeEqual(cookie, expected)) return; // hand off to Next.js

  // A bare GET of the login path with no valid cookie: show the form for "/".
  const next = url.pathname === LOGIN_PATH ? '/' : url.pathname + url.search;
  return loginPage(next, false, false);
}

export const config = { path: '/*' };
