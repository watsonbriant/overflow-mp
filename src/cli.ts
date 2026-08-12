import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { config } from './env.ts';
import { sync } from './sync.ts';

const STATE_DIR = new URL('../state/', import.meta.url).pathname;
const STATE_FILE = `${STATE_DIR}watermark.json`;

function readWatermark(): string | null {
  try {
    return (JSON.parse(readFileSync(STATE_FILE, 'utf8')) as { lastUpdatedAt?: string })
      .lastUpdatedAt ?? null;
  } catch {
    return null;
  }
}

function writeWatermark(iso: string): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, `${JSON.stringify({ lastUpdatedAt: iso }, null, 2)}\n`);
}

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const HELP = `
Overflow → MinistryPlatform sync

  node src/cli.ts [options]

  --dry-run        Report what would be written. No writes. Always start here.
  --since=<ISO>    Override the stored watermark (e.g. 2026-08-01T00:00:00Z).
  --all            Ignore the watermark; reconsider everything since SYNC_FROM_DATE.
  --limit=<n>      Process at most n contributions. Good for a first live run.
  --help

Safe by construction: every donation carries its Overflow contribution id in
Transaction_Code and is checked before insert, so re-running never double-posts.
`;

async function main(): Promise<void> {
  if (flag('help')) {
    console.log(HELP);
    return;
  }

  const dryRun = flag('dry-run');
  const since = arg('since') ?? (flag('all') ? config.syncFromDate : readWatermark() ?? config.syncFromDate);
  const limitRaw = arg('limit');
  const limit = limitRaw === undefined ? undefined : Number(limitRaw);

  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error(`--limit must be a positive integer, got "${limitRaw}"`);
  }

  const startedAt = new Date().toISOString();
  const result = await sync({ dryRun, since, limit });

  console.log('\n─────────────────────────────────');
  console.log(`  considered : ${result.considered}`);
  console.log(`  created    : ${result.created}`);
  console.log(`  skipped    : ${result.skipped}  (already present)`);
  console.log(`  repaired   : ${result.repaired}`);
  console.log(`  failed     : ${result.failed.length}`);

  if (result.failed.length > 0) {
    console.log('\nFailures — watermark NOT advanced, so these retry on the next run:');
    for (const f of result.failed) console.log(`  ${f.id}\n    ${f.reason}`);
  }

  if (dryRun) {
    console.log('\nDry run — nothing was written and the watermark was not moved.');
    return;
  }

  // Only advance past a clean run. Re-processing is free (idempotent); silently
  // skipping a failed gift is not.
  if (result.failed.length === 0) {
    writeWatermark(startedAt);
    console.log(`\nWatermark advanced to ${startedAt}`);
  }

  if (result.failed.length > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(`\nFATAL: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
