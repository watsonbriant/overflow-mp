/**
 * Whether a browser request came from this site's own pages.
 *
 * Compares against the Host headers, never request.url: behind Azure's front end
 * the app listens on an internal address, so request.url names that address and
 * every genuine request would look cross-origin. Browsers do not let a page set
 * Host or X-Forwarded-Host, so a cross-site form cannot fake a match.
 *
 * A request with no Origin header is not a cross-site browser POST, so it passes.
 */
export function isSameOrigin(headers: Headers): boolean {
  const origin = headers.get('origin');
  if (!origin) return true;

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }

  const forwarded = headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  return originHost === (forwarded || headers.get('host'));
}
