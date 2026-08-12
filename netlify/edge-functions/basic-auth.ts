/**
 * HTTP Basic Auth over the whole site.
 *
 * The preview renders real donor names, email addresses, and gift amounts, so
 * this page must never be openly reachable. Netlify sites are public by default
 * and its built-in password protection is a paid-plan feature, so this gate runs
 * at the edge on any plan.
 *
 * Set in Netlify → Site configuration → Environment variables:
 *   PREVIEW_PASSWORD  (required)
 *   PREVIEW_USER      (optional — any username is accepted when unset, so
 *                      stakeholders only need the one shared password)
 *
 * Fails CLOSED. If PREVIEW_PASSWORD is missing the site is locked rather than
 * open — a misconfiguration should cost you access, not your donors' privacy.
 *
 * The password is read from the environment on purpose: committing a shared
 * secret that guards donor data would leave it in git history permanently.
 */

/** Length-independent comparison, so timing can't be used to recover the password. */
function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  // Compare a fixed number of bytes regardless of input length.
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return diff === 0;
}

function challenge(body: string): Response {
  return new Response(body, {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Overflow preview", charset="UTF-8"',
      'Content-Type': 'text/plain; charset=utf-8',
      // Never let an intermediary cache a protected page or a challenge.
      'Cache-Control': 'no-store, private',
    },
  });
}

export default async function handler(request: Request): Promise<Response | void> {
  const password = Deno.env.get('PREVIEW_PASSWORD');
  // Optional. When unset, any username is accepted and only the password matters.
  const user = Deno.env.get('PREVIEW_USER');

  if (!password) {
    return challenge(
      'This preview is locked: PREVIEW_PASSWORD is not configured in Netlify.\n',
    );
  }

  const header = request.headers.get('authorization') ?? '';
  const [scheme, encoded] = header.split(' ');
  if (scheme?.toLowerCase() !== 'basic' || !encoded) {
    return challenge('Authentication required.\n');
  }

  let decoded: string;
  try {
    decoded = atob(encoded);
  } catch {
    return challenge('Malformed credentials.\n');
  }

  // Only split on the FIRST colon — passwords may contain colons.
  const sep = decoded.indexOf(':');
  if (sep < 0) return challenge('Malformed credentials.\n');

  const okUser = user ? safeEqual(decoded.slice(0, sep), user) : true;
  const okPass = safeEqual(decoded.slice(sep + 1), password);

  // Evaluate both before branching, so failure timing doesn't reveal which was wrong.
  if (!(okUser && okPass)) return challenge('Invalid credentials.\n');

  // Authenticated — hand off to Next.js.
}

export const config = { path: '/*' };
