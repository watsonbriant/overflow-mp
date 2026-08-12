import { NextResponse } from 'next/server';
import { buildPlan } from '@/src/plan.ts';

// Reads MP and Overflow over the network with the Node APIs the clients use.
export const runtime = 'nodejs';
// Every request re-reads live data; a cached preview would mislead stakeholders.
export const dynamic = 'force-dynamic';

/** Far enough back to cover all Overflow history; the account began in 2026. */
const LIFETIME = '2000-01-01T00:00:00Z';

export async function GET(request: Request): Promise<NextResponse> {
  const params = new URL(request.url).searchParams;
  const from = params.get('range') === 'lifetime' ? LIFETIME : (params.get('from') ?? undefined);

  try {
    const plan = await buildPlan({ from });
    return NextResponse.json(plan, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[plan] failed:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
