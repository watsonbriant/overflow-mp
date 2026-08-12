// Imported rather than read from disk: a bundled serverless function has no
// reliable working directory, so fs+cwd works locally and 404s once deployed.
import mappingFile from '../config/fund-mapping.json' with { type: 'json' };
import { mp } from './mp.ts';
import type { OverflowContribution } from './overflow.ts';

interface FundRow {
  campaign: string;
  campaignId: string;
  subcampaign: string;
  subcampaignId: string;
  programId: number;
  programName: string;
  congregationId: number;
  note?: string;
}

interface MappingFile {
  campuses: Record<string, { overflow: string; congregationId: number }>;
  funds: FundRow[];
  paymentTypes: {
    byPaymentMethod: Record<string, number>;
    byAssetType: Record<string, number | null>;
    fallback: number | null;
  };
  syncPolicy: {
    invoiceNumberPrefix: string;
    failOnEndedProgram: boolean;
    failOnUnmappedFund: boolean;
  };
}

const mapping = mappingFile as unknown as MappingFile;

export const policy = mapping.syncPolicy;

/**
 * Keyed on campaign AND subcampaign: four subcampaign ids are reused verbatim
 * across all four campuses, so subcampaign alone cannot identify a fund.
 */
const fundIndex = new Map<string, FundRow>(
  mapping.funds.map((f) => [`${f.campaignId}::${f.subcampaignId}`, f]),
);

export class MappingError extends Error {}

/**
 * The congregation the Overflow campaign itself represents — i.e. where the
 * donor actually gave. This differs from the target program's congregation for
 * the two churchwide funds (Freedom Academy, Outreach + Missions), and that gap
 * is worth reporting rather than hiding.
 */
export function campaignCongregation(campaignId: string): number | null {
  return mapping.campuses[campaignId]?.congregationId ?? null;
}

export function resolveFund(c: OverflowContribution): FundRow {
  const campaignId = c.campaign?.id;
  const subcampaignId = c.subcampaign?.id;
  if (!campaignId || !subcampaignId) {
    throw new MappingError(
      `Contribution ${c.id} has no campaign/subcampaign — cannot determine fund or campus`,
    );
  }
  const hit = fundIndex.get(`${campaignId}::${subcampaignId}`);
  if (!hit) {
    throw new MappingError(
      `Unmapped fund: campaign "${c.campaign?.name}" (${campaignId}) + ` +
        `subcampaign "${c.subcampaign?.name}" (${subcampaignId}). ` +
        `Add it to config/fund-mapping.json.`,
    );
  }
  return hit;
}

export function resolvePaymentType(c: OverflowContribution): number {
  const method = c.paymentMethod?.type?.trim();
  if (method) {
    const byMethod = mapping.paymentTypes.byPaymentMethod[method];
    if (byMethod) return byMethod;
  }
  const byAsset = mapping.paymentTypes.byAssetType[c.type];
  if (byAsset) return byAsset;

  const fallback = mapping.paymentTypes.fallback;
  if (fallback) return fallback;

  throw new MappingError(
    `No payment type mapping for contribution ${c.id} ` +
      `(type="${c.type}", paymentMethod="${method ?? 'none'}"). ` +
      `Add it to config/fund-mapping.json rather than guessing — a wrong ` +
      `Payment_Type_ID corrupts finance reporting silently.`,
  );
}

/**
 * Guards against the annual-rollover failure: MP programs are year-scoped
 * ("Liberty 2026") while Overflow subcampaigns are not ("Liberty"), so this
 * mapping goes stale every year. Posting into a closed program is invisible
 * until reconciliation, so refuse instead.
 */
export async function assertProgramsOpen(programIds: number[]): Promise<void> {
  const unique = [...new Set(programIds)];
  if (unique.length === 0) return;

  const rows = await mp.select<{
    Program_ID: number;
    Program_Name: string;
    End_Date: string | null;
  }>('Programs', `$select=Program_ID,Program_Name,End_Date&$filter=Program_ID in (${unique.join(',')})`);

  const now = Date.now();
  const problems: string[] = [];
  const found = new Set(rows.map((r) => r.Program_ID));

  for (const id of unique) {
    if (!found.has(id)) problems.push(`Program ${id} does not exist in MinistryPlatform`);
  }
  for (const r of rows) {
    if (r.End_Date && new Date(r.End_Date).getTime() < now) {
      problems.push(
        `Program ${r.Program_ID} "${r.Program_Name}" ended ${r.End_Date.slice(0, 10)} — ` +
          `update config/fund-mapping.json to this year's program`,
      );
    }
  }

  if (problems.length && policy.failOnEndedProgram) {
    throw new MappingError(`Program validation failed:\n  - ${problems.join('\n  - ')}`);
  }
  for (const p of problems) console.warn(`  ! ${p}`);
}
