import { config } from './env.ts';

/** Doubles single quotes for MP's OData-ish $filter string literals. */
export function sqlStr(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

let cached: { token: string; expiresAt: number } | null = null;

async function token(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: config.mp.clientId,
    client_secret: config.mp.clientSecret,
    scope: config.mp.scope,
  });

  const res = await fetch(`${config.mp.base}/oauth/connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`MP token request failed (${res.status}): ${text}`);

  const json = JSON.parse(text) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error(`MP token response had no access_token: ${text}`);

  // Renew a minute early so a long run can't die mid-write on an expired token.
  cached = {
    token: json.access_token,
    expiresAt: Date.now() + ((json.expires_in ?? 3600) - 60) * 1000,
  };
  return cached.token;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${config.mp.base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await token()}`,
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`MP ${method} ${path} failed (${res.status}): ${text}`);
  }
  return (text ? JSON.parse(text) : null) as T;
}

export const mp = {
  /** GET rows from a table. `query` is appended raw, so pre-encode filter values. */
  select<T = Record<string, unknown>>(table: string, query: string): Promise<T[]> {
    const sep = query.startsWith('?') ? '' : '?';
    return call<T[]>('GET', `/tables/${table}${sep}${query}`);
  },

  /** POST new rows. MP takes and returns an array. */
  insert<T = Record<string, unknown>>(table: string, rows: object[]): Promise<T[]> {
    return call<T[]>('POST', `/tables/${table}`, rows);
  },

  /** PUT existing rows. Each row must include its primary key. */
  update<T = Record<string, unknown>>(table: string, rows: object[]): Promise<T[]> {
    return call<T[]>('PUT', `/tables/${table}`, rows);
  },
};

/** MP wants naive local datetimes, not ISO-8601 with a Z offset. */
export function mpDateTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}
