import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

/**
 * Path is built at runtime, deliberately. `new URL('../.env', import.meta.url)`
 * reads identically but bundlers statically resolve it as an asset reference,
 * which makes the whole build fail when .env is absent — i.e. on every hosted
 * deploy, where the values come from the platform's environment instead.
 *
 * Only needed for the CLI. Next.js loads .env into process.env on its own.
 */
const fileEnv = readEnvFile(join(process.cwd(), '.env'));

function required(name: string): string {
  const v = process.env[name] ?? fileEnv[name];
  if (!v) throw new Error(`Missing required config: ${name} (set it in .env)`);
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fileEnv[name] ?? fallback;
}

/**
 * Every required value is a getter, resolved on access rather than at import.
 *
 * This matters for hosted deploys: a build step that merely imports a module in
 * this graph would otherwise throw before any request is served, turning a
 * missing environment variable into an opaque build failure instead of a clear
 * runtime error.
 */
export const config = {
  mp: {
    get domain() {
      return required('MP_DOMAIN');
    },
    get clientId() {
      return required('MP_CLIENT_ID');
    },
    get clientSecret() {
      return required('MP_CLIENT_SECRET');
    },
    get base() {
      return `https://${config.mp.domain}/ministryplatformapi`;
    },
    scope: 'http://www.thinkministry.com/dataplatform/scopes/all',
  },
  overflow: {
    get base() {
      return optional('OVERFLOW_BASE', 'https://server.overflow.co');
    },
    get clientId() {
      return required('OVERFLOW_CLIENT_ID');
    },
    get apiKey() {
      return required('OVERFLOW_API_KEY');
    },
  },
  /**
   * Household_Source_ID stamped on households the sync creates, so machine-made
   * records stay identifiable. 38 = "Overflow" (added 2026-08-12).
   */
  get householdSourceId() {
    return Number(optional('MP_HOUSEHOLD_SOURCE_ID', '38'));
  },
  /**
   * Contributions dated before this are ignored entirely.
   *
   * This is the single most important safety value in the project. Staff keyed
   * Overflow gifts into MinistryPlatform by hand through **2026-08-02** — 15
   * batches, 125 gifts, $17,773.24. Those donations carry no Overflow
   * contribution id, so the sync's normal duplicate check cannot see them, and
   * syncing any date on or before the cutoff would double-post real money to
   * real donor records.
   *
   * Raise this only after confirming the team has stopped entering gifts by hand
   * for the period concerned.
   */
  get syncFromDate() {
    return optional('SYNC_FROM_DATE', '2026-08-03T00:00:00Z');
  },
};
