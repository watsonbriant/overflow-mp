import { readFileSync } from 'node:fs';

/**
 * Minimal .env reader. Deliberately does not eval/source the file — MP-generated
 * client secrets routinely contain `;`, `^`, `$` and `` ` ``.
 */
function readEnvFile(path: string): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

const fileEnv = readEnvFile(new URL('../.env', import.meta.url).pathname);

function required(name: string): string {
  const v = process.env[name] ?? fileEnv[name];
  if (!v) throw new Error(`Missing required config: ${name} (set it in .env)`);
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fileEnv[name] ?? fallback;
}

export const config = {
  mp: {
    domain: required('MP_DOMAIN'),
    clientId: required('MP_CLIENT_ID'),
    clientSecret: required('MP_CLIENT_SECRET'),
    get base() {
      return `https://${config.mp.domain}/ministryplatformapi`;
    },
    scope: 'http://www.thinkministry.com/dataplatform/scopes/all',
  },
  overflow: {
    base: optional('OVERFLOW_BASE', 'https://server.overflow.co'),
    clientId: required('OVERFLOW_CLIENT_ID'),
    apiKey: required('OVERFLOW_API_KEY'),
  },
  /**
   * Household_Source_ID stamped on households the sync creates, so machine-made
   * records stay identifiable. 38 = "Overflow" (added 2026-08-12).
   */
  householdSourceId: Number(optional('MP_HOUSEHOLD_SOURCE_ID', '38')),
  /**
   * Contributions before this date are ignored entirely. Overflow and
   * OnlineGiving.org run in parallel, so this is the guard against back-filling
   * gifts that were already posted to MP by another path.
   */
  syncFromDate: optional('SYNC_FROM_DATE', '2026-08-01T00:00:00Z'),
};
