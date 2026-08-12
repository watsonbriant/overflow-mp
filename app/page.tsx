'use client';

import { useCallback, useEffect, useState } from 'react';
// Type-only import: erased at build, so no server code reaches the client bundle.
import type { Plan, PlanRow } from '@/src/plan.ts';

const usd = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

const usdCompact = (n: number) =>
  n >= 10000
    ? `$${(n / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })}K`
    : usd(n);

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/**
 * For configured boundary dates, which are UTC midnight. Formatting those in
 * local time renders "Aug 1" as "Jul 31", which reads like an off-by-one bug.
 */
const utcDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });

export default function Page() {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/plan', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
      setPlan(body as Plan);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="mx-auto w-full max-w-6xl px-5 py-8 sm:px-8">
      <Banner />

      <header className="mt-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Overflow → MinistryPlatform
          </h1>
          <p className="mt-1 text-sm text-ink-2">
            Giving data that would transfer, pending approval to go live.
          </p>
        </div>
        <button
          onClick={() => void load()}
          disabled={loading}
          className="rounded-md border px-3 py-2 text-sm font-medium text-ink-2 transition-colors hover:text-ink disabled:opacity-50"
          style={{ borderColor: 'var(--hairline)', background: 'var(--surface)' }}
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </header>

      {error && <ErrorCard message={error} onRetry={() => void load()} />}
      {loading && !plan && <Skeleton />}

      {plan && (
        <div className="mt-7 space-y-7">
          <Headline plan={plan} />
          <Kpis plan={plan} />
          {plan.byCampus.length > 0 && <CampusChart plan={plan} />}
          {plan.byProgram.length > 0 && <FundTable plan={plan} />}
          <Attention rows={plan.rows} />
          <DetailTable rows={plan.rows} />
          <Provenance plan={plan} />
        </div>
      )}
    </main>
  );
}

/* ------------------------------------------------------------------ pieces */

function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <section
      className={`rounded-xl border p-5 ${className}`}
      style={{ borderColor: 'var(--hairline)', background: 'var(--surface)' }}
    >
      {children}
    </section>
  );
}

function Banner() {
  return (
    <div
      className="flex items-start gap-3 rounded-xl border p-4"
      style={{ borderColor: 'var(--hairline)', background: 'var(--series-wash)' }}
    >
      <span aria-hidden className="mt-0.5 text-base leading-none">
        🔍
      </span>
      <p className="text-sm leading-relaxed">
        <strong className="font-semibold">Preview only.</strong> Nothing on this page has
        been written to MinistryPlatform. This view reads both systems and reports what
        the sync <em>would</em> create once it&rsquo;s approved to go live.
      </p>
    </div>
  );
}

function Headline({ plan }: { plan: Plan }) {
  const { toCreate, toCreateAmount } = plan.totals;
  return (
    <Card>
      <p className="text-sm text-ink-2">Total that would transfer</p>
      <p className="mt-1 text-5xl font-semibold tracking-tight">{usd(toCreateAmount)}</p>
      <p className="mt-2 text-sm text-ink-2">
        across <span className="font-medium text-ink">{toCreate}</span>{' '}
        {toCreate === 1 ? 'gift' : 'gifts'} confirmed in Overflow since{' '}
        {utcDate(plan.syncFromDate)}
      </p>
    </Card>
  );
}

function Kpis({ plan }: { plan: Plan }) {
  const t = plan.totals;
  const tiles: { label: string; value: string; note?: string; tone?: 'critical' }[] = [
    { label: 'Gifts to transfer', value: String(t.toCreate) },
    {
      label: 'Already in MinistryPlatform',
      value: String(t.alreadyInMp),
      note: t.alreadyInMp > 0 ? 'skipped, never double-posted' : undefined,
    },
    {
      label: 'New people to create',
      value: String(t.newContacts),
      note: 'no matching email in MP',
    },
    {
      label: 'Needs attention',
      value: String(t.blocked),
      tone: t.blocked > 0 ? 'critical' : undefined,
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {tiles.map((tile) => (
        <Card key={tile.label}>
          <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">
            {tile.label}
          </p>
          <p
            className="mt-2 text-3xl font-semibold tracking-tight"
            style={tile.tone === 'critical' ? { color: 'var(--critical)' } : undefined}
          >
            {tile.value}
          </p>
          {tile.note && <p className="mt-1 text-xs text-ink-2">{tile.note}</p>}
        </Card>
      ))}
    </div>
  );
}

/**
 * Magnitude comparison across a handful of campuses: horizontal bars, one
 * sequential hue (length carries the value, not color). Single series, so no
 * legend — the heading names what's plotted.
 */
function CampusChart({ plan }: { plan: Plan }) {
  const data = plan.byGivenAtCampus;
  const max = Math.max(...data.map((c) => c.amount), 1);
  const { reattributedCount, reattributedAmount } = plan.totals;

  return (
    <Card>
      <h2 className="text-sm font-semibold">Where donors gave, by campus</h2>
      <p className="mt-1 text-xs text-ink-2">
        Taken from the Overflow campaign the donor selected &mdash; that is, the campus
        actually credited with the gift.
      </p>

      <ul className="mt-5 space-y-4">
        {data.map((c) => {
          const pct = (c.amount / max) * 100;
          const avg = c.amount / c.count;
          return (
            <li key={c.campus} className="group">
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="font-medium">{c.campus}</span>
                <span className="tnum text-ink-2">
                  {c.count} {c.count === 1 ? 'gift' : 'gifts'}
                </span>
              </div>
              <div className="mt-1.5 flex items-center gap-3">
                <div
                  className="h-3 flex-1 overflow-hidden rounded-sm"
                  style={{ background: 'var(--grid)' }}
                >
                  <div
                    className="h-3 transition-[width] duration-500"
                    style={{
                      width: `${Math.max(pct, 1.5)}%`,
                      background: 'var(--series)',
                      borderRadius: '0 4px 4px 0',
                    }}
                    title={`${c.campus}: ${usd(c.amount)} across ${c.count} gifts (avg ${usd(avg)})`}
                  />
                </div>
                <span className="tnum w-24 shrink-0 text-right text-sm font-medium">
                  {usdCompact(c.amount)}
                </span>
              </div>
            </li>
          );
        })}
      </ul>

      {reattributedCount > 0 && (
        <div
          className="mt-5 rounded-lg border p-3 text-xs leading-relaxed"
          style={{ borderColor: 'var(--hairline)' }}
        >
          <span aria-hidden className="mr-1.5" style={{ color: 'var(--warning)' }}>
            ▲
          </span>
          <strong className="font-semibold">
            {usd(reattributedAmount)} of this ({reattributedCount}{' '}
            {reattributedCount === 1 ? 'gift' : 'gifts'}) lands on a different
            campus&rsquo;s books.
          </strong>{' '}
          Freedom Academy and Outreach + Missions are single churchwide funds in
          MinistryPlatform, so a gift given at Ballantyne posts to the program that
          belongs to Central or Offsite. That was a deliberate choice &mdash; the
          alternative is creating per-campus versions of those two funds. Per-campus
          giving reports will be off by this amount.
        </div>
      )}
    </Card>
  );
}

function FundTable({ plan }: { plan: Plan }) {
  return (
    <Card className="overflow-hidden">
      <h2 className="text-sm font-semibold">By MinistryPlatform fund</h2>
      <div className="mt-4 -mx-5 overflow-x-auto px-5">
        <table className="w-full min-w-[34rem] text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-ink-muted">
              <th className="pb-2 pr-4 font-medium">Program</th>
              <th className="pb-2 pr-4 font-medium">Books to campus</th>
              <th className="pb-2 pr-4 text-right font-medium">ID</th>
              <th className="pb-2 pr-4 text-right font-medium">Gifts</th>
              <th className="pb-2 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {plan.byProgram.map((p) => (
              <tr key={p.programId} className="border-t" style={{ borderColor: 'var(--grid)' }}>
                <td className="py-2.5 pr-4 font-medium">{p.programName}</td>
                <td className="py-2.5 pr-4 text-ink-2">{p.campus}</td>
                <td className="tnum py-2.5 pr-4 text-right text-ink-muted">{p.programId}</td>
                <td className="tnum py-2.5 pr-4 text-right text-ink-2">{p.count}</td>
                <td className="tnum py-2.5 text-right font-medium">{usd(p.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function Attention({ rows }: { rows: PlanRow[] }) {
  const flagged = rows.filter((r) => r.action === 'blocked' || r.problem);
  if (flagged.length === 0) {
    return (
      <Card>
        <div className="flex items-center gap-2.5">
          <span aria-hidden style={{ color: 'var(--good)' }}>
            ✓
          </span>
          <p className="text-sm">
            <span className="font-medium">Nothing needs attention.</span>{' '}
            <span className="text-ink-2">
              Every gift maps to an open fund with a known payment type.
            </span>
          </p>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <span aria-hidden style={{ color: 'var(--warning)' }}>
          ▲
        </span>
        Needs attention ({flagged.length})
      </h2>
      <ul className="mt-3 space-y-3">
        {flagged.map((r) => (
          <li
            key={r.overflowId}
            className="rounded-lg border p-3 text-sm"
            style={{ borderColor: 'var(--hairline)' }}
          >
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="font-medium">{usd(r.amount)}</span>
              <span className="text-ink-2">{r.donorName}</span>
              <span className="text-ink-muted">{shortDate(r.contributionDate)}</span>
            </div>
            <p className="mt-1.5 text-ink-2">{r.problem}</p>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function StatusPill({ row }: { row: PlanRow }) {
  const map = {
    create: { color: 'var(--good)', glyph: '●', label: 'Will transfer' },
    skip: { color: 'var(--ink-muted)', glyph: '○', label: 'Already in MP' },
    repair: { color: 'var(--warning)', glyph: '◐', label: 'Needs repair' },
    blocked: { color: 'var(--critical)', glyph: '▲', label: 'Blocked' },
  } as const;
  const s = map[row.action];
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span aria-hidden style={{ color: s.color }}>
        {s.glyph}
      </span>
      <span className="text-ink-2">{s.label}</span>
    </span>
  );
}

function DetailTable({ rows }: { rows: PlanRow[] }) {
  return (
    <Card className="overflow-hidden">
      <h2 className="text-sm font-semibold">Every gift, line by line</h2>
      <p className="mt-1 text-xs text-ink-2">
        The Overflow fund on the left, the MinistryPlatform program it resolves to on the
        right. &ldquo;New&rdquo; means no MP contact shares that email address.
      </p>
      <div className="mt-4 -mx-5 overflow-x-auto px-5">
        <table className="w-full min-w-[58rem] text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-ink-muted">
              <th className="pb-2 pr-4 font-medium">Date</th>
              <th className="pb-2 pr-6 text-right font-medium">Amount</th>
              <th className="pb-2 pr-4 font-medium">Donor</th>
              <th className="pb-2 pr-4 font-medium">Overflow fund</th>
              <th className="pb-2 pr-4 font-medium">MP program</th>
              <th className="pb-2 pr-4 font-medium">Payment</th>
              <th className="pb-2 pr-4 font-medium">Contact</th>
              <th className="pb-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.overflowId} className="border-t" style={{ borderColor: 'var(--grid)' }}>
                <td className="tnum py-2.5 pr-4 whitespace-nowrap text-ink-2">
                  {shortDate(r.contributionDate)}
                </td>
                <td className="tnum py-2.5 pr-6 text-right font-medium">{usd(r.amount)}</td>
                <td className="py-2.5 pr-4">
                  <div className="font-medium">{r.donorName}</div>
                  {r.donorEmail && (
                    <div className="text-xs text-ink-muted">{r.donorEmail}</div>
                  )}
                </td>
                <td className="py-2.5 pr-4 text-ink-2">
                  <div>{r.subcampaign ?? '—'}</div>
                  <div className="text-xs text-ink-muted">{r.campaign ?? ''}</div>
                </td>
                <td className="py-2.5 pr-4">
                  <div>{r.programName ?? '—'}</div>
                  {r.programId !== null && (
                    <div className="tnum text-xs text-ink-muted">
                      #{r.programId}
                      {r.reattributed && (
                        <span style={{ color: 'var(--warning)' }}> · books to {r.campus}</span>
                      )}
                    </div>
                  )}
                </td>
                <td className="py-2.5 pr-4 whitespace-nowrap text-ink-2">
                  {r.paymentType ?? '—'}
                </td>
                <td className="py-2.5 pr-4 whitespace-nowrap">
                  {r.contactAction === 'match' ? (
                    <span className="tnum text-ink-2">#{r.mpContactId}</span>
                  ) : r.contactAction === 'create' ? (
                    <span style={{ color: 'var(--series)' }}>New</span>
                  ) : (
                    <span className="text-ink-muted">—</span>
                  )}
                </td>
                <td className="py-2.5">
                  <StatusPill row={r} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function Provenance({ plan }: { plan: Plan }) {
  return (
    <p className="pb-4 text-xs leading-relaxed text-ink-muted">
      Generated {new Date(plan.generatedAt).toLocaleString('en-US')} · reading live data
      from Overflow and MinistryPlatform · only contributions Overflow reports as
      confirmed are considered · gifts dated before {utcDate(plan.syncFromDate)} are
      excluded so nothing already posted by OnlineGiving.org is duplicated.
    </p>
  );
}

function ErrorCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      className="mt-6 rounded-xl border p-5"
      style={{ borderColor: 'var(--critical)', background: 'var(--surface)' }}
    >
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <span aria-hidden style={{ color: 'var(--critical)' }}>
          ▲
        </span>
        Could not build the preview
      </h2>
      <pre className="mt-3 overflow-x-auto text-xs leading-relaxed text-ink-2">{message}</pre>
      <button
        onClick={onRetry}
        className="mt-4 rounded-md border px-3 py-2 text-sm font-medium"
        style={{ borderColor: 'var(--hairline)' }}
      >
        Try again
      </button>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="mt-7 space-y-4" aria-busy="true">
      <div className="h-28 animate-pulse rounded-xl" style={{ background: 'var(--grid)' }} />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-24 animate-pulse rounded-xl"
            style={{ background: 'var(--grid)' }}
          />
        ))}
      </div>
      <div className="h-64 animate-pulse rounded-xl" style={{ background: 'var(--grid)' }} />
    </div>
  );
}
