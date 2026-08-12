import { NextResponse } from 'next/server';
import { buildPlan } from '@/src/plan.ts';

// Reads MP and Overflow over the network with the Node APIs the clients use.
export const runtime = 'nodejs';
// Every request re-reads live data; a cached preview would mislead stakeholders.
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  const since = new URL(request.url).searchParams.get('since') ?? undefined;

  try {
    const plan = await buildPlan(since);
    return NextResponse.json(plan, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[plan] failed:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
