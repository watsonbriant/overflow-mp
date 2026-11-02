import { NextResponse, after } from 'next/server';
import { buildPlan } from '@/src/plan.ts';
import { sync, type SyncResult } from '@/src/sync.ts';
import { config } from '@/src/env.ts';
import { isSameOrigin } from '@/src/same-origin.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The one code path on the site that WRITES to MinistryPlatform.
 *
 * Off unless MERGE_ENABLED=true. The lock below lives in this process's memory,
 * so it only prevents concurrent merges on a single long-lived server (Azure App
 * Service). On serverless hosts (Netlify) each request may land on a different
 * instance, two merges could race the Transaction_Code check and double-post, and
 * a function timeout could cut a run off mid-gift. Leave it off there.
 *
 * The merge runs after the response is sent and the page polls GET for progress:
 * Azure's front end drops any request open longer than ~230s, and a backlog of
 * gifts can take longer than that.
 */
const enabled = () => process.env.MERGE_ENABLED === 'true';

export interface MergeState {
  enabled: boolean;
  status: 'idle' | 'running' | 'done' | 'failed';
  startedAt: string | null;
  finishedAt: string | null;
  done: number;
  total: number;
  result: SyncResult | null;
  error: string | null;
}

let state: MergeState = {
  enabled: false,
  status: 'idle',
  startedAt: null,
  finishedAt: null,
  done: 0,
  total: 0,
  result: null,
  error: null,
};

const snapshot = () =>
  NextResponse.json({ ...state, enabled: enabled() }, { headers: { 'Cache-Control': 'no-store' } });

export async function GET(): Promise<NextResponse> {
  return snapshot();
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!enabled()) {
    return NextResponse.json({ error: 'Merging is not enabled on this site.' }, { status: 403 });
  }

  // The gate's cookie is SameSite=Lax, which already keeps it off cross-site
  // POSTs; this is a second check, since this request moves money.
  if (!isSameOrigin(request.headers)) {
    return NextResponse.json({ error: 'Cross-origin request refused.' }, { status: 403 });
  }

  // Claimed synchronously, before any await, so two clicks cannot both start.
  if (state.status === 'running') {
    return NextResponse.json({ error: 'A merge is already running.' }, { status: 409 });
  }
  state = {
    enabled: true,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    done: 0,
    total: 0,
    result: null,
    error: null,
  };

  after(async () => {
    try {
      // Merge exactly what the preview lists as "will transfer". The plan also
      // detects gifts staff keyed in by hand, which the sync alone cannot see.
      const plan = await buildPlan();
      const ids = new Set(plan.rows.filter((r) => r.action === 'create').map((r) => r.overflowId));
      state.total = ids.size;

      const result =
        ids.size === 0
          ? { considered: 0, created: 0, skipped: 0, repaired: 0, failed: [] }
          : await sync({
              dryRun: false,
              since: config.syncFromDate,
              onlyIds: ids,
              onProgress: (done, total) => {
                state.done = done;
                state.total = total;
              },
            });

      state.result = result;
      state.status = result.failed.length > 0 ? 'failed' : 'done';
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err);
      state.status = 'failed';
      console.error('[merge] failed:', state.error);
    } finally {
      state.finishedAt = new Date().toISOString();
    }
  });

  return snapshot();
}
