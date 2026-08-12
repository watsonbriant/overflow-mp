/**
 * Read-only preview of what the sync WOULD write.
 *
 * This module deliberately never imports mp.insert / mp.update. Stakeholders
 * will be looking at output built from this code path, so it is structurally
 * incapable of modifying MinistryPlatform — not merely configured not to.
 *
 * Lookups are batched: one query per table per chunk rather than three per gift,
 * which is the difference between a ~1s page and a ~12s one.
 */
// See mapping.ts — imported, not read from disk, so it survives bundling.
import mappingFile from '../config/fund-mapping.json' with { type: 'json' };
import { mp, sqlStr } from './mp.ts';
import { overflow, type OverflowContribution } from './overflow.ts';
import { MappingError, campaignCongregation, resolveFund, resolvePaymentType } from './mapping.ts';
import { config } from './env.ts';

export type Action = 'create' | 'skip' | 'repair' | 'blocked';

export interface PlanRow {
  overflowId: string;
  contributionDate: string;
  amount: number;
  overflowStatus: string;

  campaign: string | null;
  subcampaign: string | null;

  programId: number | null;
  programName: string | null;
  /** Congregation of the target MP program — where the gift lands. */
  congregationId: number | null;
  campus: string | null;
  /** Campus the donor actually gave at, from the Overflow campaign. */
  givenAtCampus: string | null;
  /** True when it lands on a different campus than it was given at (churchwide funds). */
  reattributed: boolean;

  paymentTypeId: number | null;
  paymentType: string | null;
  paymentMethod: string | null;

  donorName: string;
  donorEmail: string | null;

  mpContactId: number | null;
  contactAction: 'match' | 'create' | null;
  mpDonorId: number | null;
  donorAction: 'match' | 'create' | null;

  action: Action;
  existingDonationId: number | null;
  /**
   * Why a gift is being skipped. 'synced' = this sync already wrote it.
   * 'hand-entered' = staff keyed it in manually, detected by donor + amount +
   * date, since a hand-entered donation carries no Overflow contribution id.
   */
  skipReason: 'synced' | 'hand-entered' | null;
  existingBatchName: string | null;
  problem: string | null;
}

export interface Plan {
  generatedAt: string;
  since: string;
  /** Earliest contribution date included in THIS view. */
  from: string;
  /** The floor the sync enforces, independent of this view. */
  syncFromDate: string;
  /** True when this view reaches further back than the sync would actually go. */
  beyondSyncFloor: boolean;
  rows: PlanRow[];
  totals: {
    count: number;
    amount: number;
    toCreate: number;
    toCreateAmount: number;
    alreadyInMp: number;
    /** Subset of alreadyInMp that staff entered by hand, not via this sync. */
    alreadyHandEntered: number;
    alreadyHandEnteredAmount: number;
    blocked: number;
    newContacts: number;
    newDonorRecords: number;
    /** Gifts landing on a different campus than they were given at. */
    reattributedCount: number;
    reattributedAmount: number;
  };
  /** Grouped by where donors gave (Overflow campaign) — the honest campus view. */
  byGivenAtCampus: { campus: string; count: number; amount: number }[];
  /** Grouped by the congregation of the MP program the gift lands on. */
  byCampus: { campus: string; count: number; amount: number }[];
  byProgram: {
    programId: number;
    programName: string;
    campus: string;
    count: number;
    amount: number;
  }[];
}

const paymentTypeNames = (mappingFile as { paymentTypes?: { names?: Record<string, string> } })
  .paymentTypes?.names ?? {};

const round = (n: number) => Math.round(n * 100) / 100;

/** MP filters go in a URL, so keep each IN() list short enough to stay well under limits. */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function congregationNames(): Promise<Map<number, string>> {
  const rows = await mp.select<{ Congregation_ID: number; Congregation_Name: string }>(
    'Congregations',
    '$select=Congregation_ID,Congregation_Name',
  );
  return new Map(rows.map((r) => [r.Congregation_ID, r.Congregation_Name]));
}

/** Which of these Overflow contribution ids already exist as MP donations. */
async function existingDonations(overflowIds: string[]): Promise<Map<string, number>> {
  const found = new Map<string, number>();
  for (const group of chunk(overflowIds, 40)) {
    const list = group.map((id) => sqlStr(id)).join(',');
    const rows = await mp.select<{ Donation_ID: number; Transaction_Code: string | null }>(
      'Donations',
      `$select=Donation_ID,Transaction_Code&$filter=${encodeURIComponent(
        `Transaction_Code in (${list})`,
      )}`,
    );
    for (const r of rows) if (r.Transaction_Code) found.set(r.Transaction_Code, r.Donation_ID);
  }
  return found;
}

/** Lowercased email → Contact_ID, for the emails we actually care about. */
async function contactsByEmail(emails: string[]): Promise<Map<string, number>> {
  const found = new Map<string, number>();
  for (const group of chunk(emails, 40)) {
    const list = group.map((e) => sqlStr(e)).join(',');
    const rows = await mp.select<{ Contact_ID: number; Email_Address: string | null }>(
      'Contacts',
      `$select=Contact_ID,Email_Address&$filter=${encodeURIComponent(
        `Email_Address in (${list})`,
      )}&$orderby=Contact_ID`,
    );
    for (const r of rows) {
      const key = r.Email_Address?.trim().toLowerCase();
      // First id wins, matching the sync's `$orderby=Contact_ID` tie-break.
      if (key && !found.has(key)) found.set(key, r.Contact_ID);
    }
  }
  return found;
}

/**
 * Finds Overflow gifts that staff already keyed into MP by hand.
 *
 * The sync's duplicate guard reads the Overflow contribution id out of
 * Transaction_Code, which a hand-entered donation does not have — so without
 * this, the preview would report money as "to transfer" that is already sitting
 * in MinistryPlatform. As of Aug 2026 the team had entered 125 such gifts, in
 * 15 batches, totalling $17,773.24 and running 2026-05-21 → 2026-08-02.
 *
 * Matches against the donations sitting in MP's manual "<date> Overflow"
 * batches, on amount + date within a few days (manual entry often uses the
 * service or deposit date rather than the gift date).
 *
 * ASSUMPTION: those batches keep "Overflow" in their name. If the team renames
 * them, detection quietly stops finding duplicates — so SYNC_FROM_DATE, not
 * this, is the real safety mechanism. This exists to keep the preview honest.
 */
async function handEnteredMatches(
  contributions: OverflowContribution[],
  ourTransactionCodes: Set<string>,
): Promise<Map<string, { donationId: number; batchId: number | null; batchName: string | null }>> {
  const DAY = 86_400_000;
  const TOLERANCE = 4 * DAY;
  const out = new Map<
    string,
    { donationId: number; batchId: number | null; batchName: string | null }
  >();

  // The team names every manual batch "<date> Overflow", so the batches are a
  // far better source than donor matching: they cover gifts posted under donors
  // whose email we cannot match (37 of 81 as of Aug 2026), which a donor-scoped
  // search structurally cannot see.
  const batches = await mp.select<{ Batch_ID: number; Batch_Name: string | null }>(
    'Batches',
    `$select=Batch_ID,Batch_Name&$filter=${encodeURIComponent(
      "Batch_Name like '%Overflow%'",
    )}&$top=500`,
  );
  if (batches.length === 0) return out;

  const batchName = new Map(batches.map((b) => [b.Batch_ID, b.Batch_Name]));

  interface Row {
    Donation_ID: number;
    Donation_Amount: number;
    Donation_Date: string;
    Transaction_Code: string | null;
    Batch_ID: number | null;
  }

  const pool: Row[] = [];
  for (const group of chunk([...batchName.keys()], 60)) {
    const rows = await mp.select<Row>(
      'Donations',
      `$select=Donation_ID,Donation_Amount,Donation_Date,Transaction_Code,Batch_ID` +
        `&$filter=${encodeURIComponent(`Batch_ID in (${group.join(',')})`)}&$top=5000`,
    );
    pool.push(...rows);
  }

  // Match on amount + date, consuming each MP donation at most once so two gifts
  // of the same amount on the same day cannot both claim one donation.
  const claimed = new Set<number>();
  for (const c of contributions) {
    const target = new Date(c.contributionDate).getTime();
    const hit = pool.find(
      (d) =>
        !claimed.has(d.Donation_ID) &&
        Math.abs(d.Donation_Amount - c.amount) < 0.005 &&
        Math.abs(new Date(d.Donation_Date).getTime() - target) <= TOLERANCE &&
        !(d.Transaction_Code && ourTransactionCodes.has(d.Transaction_Code)),
    );
    if (hit) {
      claimed.add(hit.Donation_ID);
      out.set(c.id, {
        donationId: hit.Donation_ID,
        batchId: hit.Batch_ID,
        batchName: hit.Batch_ID !== null ? (batchName.get(hit.Batch_ID) ?? null) : null,
      });
    }
  }
  return out;
}


async function donorsByContact(contactIds: number[]): Promise<Map<number, number>> {
  const found = new Map<number, number>();
  for (const group of chunk(contactIds, 80)) {
    const rows = await mp.select<{ Donor_ID: number; Contact_ID: number }>(
      'Donors',
      `$select=Donor_ID,Contact_ID&$filter=${encodeURIComponent(
        `Contact_ID in (${group.join(',')})`,
      )}&$orderby=Donor_ID`,
    );
    for (const r of rows) if (!found.has(r.Contact_ID)) found.set(r.Contact_ID, r.Donor_ID);
  }
  return found;
}

export interface PlanOptions {
  /**
   * Earliest contribution date to include. Defaults to SYNC_FROM_DATE, which is
   * the floor the sync itself enforces. The preview may look further back to
   * show stakeholders the full history — viewing lifetime data is safe, syncing
   * it is a separate decision (see README).
   */
  from?: string;
}

export async function buildPlan(opts: PlanOptions = {}): Promise<Plan> {
  const from = opts.from ?? config.syncFromDate;
  const since = from;
  const floor = new Date(from).getTime();

  const [contributions, campuses] = await Promise.all([
    overflow.contributions(since),
    congregationNames(),
  ]);

  const inScope = contributions
    .filter((c) => new Date(c.contributionDate).getTime() >= floor)
    .sort((a, b) => a.contributionDate.localeCompare(b.contributionDate));

  const emails = [
    ...new Set(
      inScope
        .map((c) => c.donor?.email?.trim().toLowerCase())
        .filter((e): e is string => !!e),
    ),
  ];

  const [donations, contacts] = await Promise.all([
    existingDonations(inScope.map((c) => c.id)),
    contactsByEmail(emails),
  ]);

  const donors = await donorsByContact([...new Set(contacts.values())]);

  const donorIdFor = (c: OverflowContribution): number | null => {
    const email = c.donor?.email?.trim().toLowerCase();
    const contactId = email ? contacts.get(email) : undefined;
    return contactId === undefined ? null : (donors.get(contactId) ?? null);
  };

  const manual = await handEnteredMatches(inScope, new Set(inScope.map((c) => c.id)));

  const rows = inScope.map((c) => planOne(c, campuses, donations, contacts, donors, manual));

  // A donor giving twice needs one new contact, not two.
  const emailsNeedingContact = new Set(
    rows.filter((r) => r.contactAction === 'create' && r.donorEmail).map((r) => r.donorEmail!),
  );
  const contactsNeedingDonor = new Set(
    rows.filter((r) => r.donorAction === 'create' && r.mpContactId).map((r) => r.mpContactId!),
  );

  const toCreate = rows.filter((r) => r.action === 'create');

  const byCampusMap = new Map<string, { count: number; amount: number }>();
  const byGivenAtMap = new Map<string, { count: number; amount: number }>();
  const byProgramMap = new Map<
    number,
    { programName: string; campus: string; count: number; amount: number }
  >();

  for (const r of toCreate) {
    const campus = r.campus ?? 'Unknown';
    const cur = byCampusMap.get(campus) ?? { count: 0, amount: 0 };
    byCampusMap.set(campus, { count: cur.count + 1, amount: cur.amount + r.amount });

    const givenAt = r.givenAtCampus ?? 'Unknown';
    const g = byGivenAtMap.get(givenAt) ?? { count: 0, amount: 0 };
    byGivenAtMap.set(givenAt, { count: g.count + 1, amount: g.amount + r.amount });

    if (r.programId !== null) {
      const p = byProgramMap.get(r.programId) ?? {
        programName: r.programName ?? String(r.programId),
        campus,
        count: 0,
        amount: 0,
      };
      byProgramMap.set(r.programId, { ...p, count: p.count + 1, amount: p.amount + r.amount });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    since,
    from,
    /** The floor the sync enforces, regardless of what this preview is showing. */
    syncFromDate: config.syncFromDate,
    beyondSyncFloor: new Date(from).getTime() < new Date(config.syncFromDate).getTime(),
    rows,
    totals: {
      count: rows.length,
      amount: round(rows.reduce((s, r) => s + r.amount, 0)),
      toCreate: toCreate.length,
      toCreateAmount: round(toCreate.reduce((s, r) => s + r.amount, 0)),
      alreadyInMp: rows.filter((r) => r.action === 'skip').length,
      alreadyHandEntered: rows.filter((r) => r.skipReason === 'hand-entered').length,
      alreadyHandEnteredAmount: round(
        rows.filter((r) => r.skipReason === 'hand-entered').reduce((s, r) => s + r.amount, 0),
      ),
      blocked: rows.filter((r) => r.action === 'blocked').length,
      newContacts: emailsNeedingContact.size,
      newDonorRecords: contactsNeedingDonor.size,
      reattributedCount: toCreate.filter((r) => r.reattributed).length,
      reattributedAmount: round(
        toCreate.filter((r) => r.reattributed).reduce((s, r) => s + r.amount, 0),
      ),
    },
    byGivenAtCampus: [...byGivenAtMap.entries()]
      .map(([campus, v]) => ({ campus, count: v.count, amount: round(v.amount) }))
      .sort((a, b) => b.amount - a.amount),
    byCampus: [...byCampusMap.entries()]
      .map(([campus, v]) => ({ campus, count: v.count, amount: round(v.amount) }))
      .sort((a, b) => b.amount - a.amount),
    byProgram: [...byProgramMap.entries()]
      .map(([programId, v]) => ({ programId, ...v, amount: round(v.amount) }))
      .sort((a, b) => b.amount - a.amount),
  };
}

function planOne(
  c: OverflowContribution,
  campuses: Map<number, string>,
  donations: Map<string, number>,
  contacts: Map<string, number>,
  donors: Map<number, number>,
  manual: Map<string, { donationId: number; batchId: number | null; batchName: string | null }>,
): PlanRow {
  const donorName =
    [c.donor?.firstName, c.donor?.lastName].filter(Boolean).join(' ') || '(unnamed)';
  const email = c.donor?.email?.trim() ?? null;

  const row: PlanRow = {
    overflowId: c.id,
    contributionDate: c.contributionDate,
    amount: c.amount,
    overflowStatus: c.status,
    campaign: c.campaign?.name ?? null,
    subcampaign: c.subcampaign?.name ?? null,
    programId: null,
    programName: null,
    congregationId: null,
    campus: null,
    givenAtCampus: null,
    reattributed: false,
    paymentTypeId: null,
    paymentType: null,
    paymentMethod: c.paymentMethod?.type ?? null,
    donorName,
    donorEmail: email,
    mpContactId: null,
    contactAction: null,
    mpDonorId: null,
    donorAction: null,
    action: 'create',
    existingDonationId: null,
    skipReason: null,
    existingBatchName: null,
    problem: null,
  };

  // Fund + payment type. A failure here blocks only this gift.
  try {
    const fund = resolveFund(c);
    row.programId = fund.programId;
    row.programName = fund.programName;
    row.congregationId = fund.congregationId;
    row.campus = campuses.get(fund.congregationId) ?? `Congregation ${fund.congregationId}`;

    const givenAtId = c.campaign?.id ? campaignCongregation(c.campaign.id) : null;
    row.givenAtCampus =
      givenAtId !== null ? (campuses.get(givenAtId) ?? `Congregation ${givenAtId}`) : null;
    row.reattributed = givenAtId !== null && givenAtId !== fund.congregationId;

    const pt = resolvePaymentType(c);
    row.paymentTypeId = pt;
    row.paymentType = paymentTypeNames[String(pt)] ?? `Payment type ${pt}`;
  } catch (err) {
    row.action = 'blocked';
    row.problem = err instanceof MappingError ? err.message : String(err);
    return row;
  }

  const existing = donations.get(c.id);
  if (existing !== undefined) {
    row.existingDonationId = existing;
    row.action = 'skip';
    row.skipReason = 'synced';
    return row;
  }

  // Keyed in by staff before the sync existed — already in MP despite carrying
  // no Overflow id, so transferring it would double-post real money.
  const byHand = manual.get(c.id);
  if (byHand) {
    row.existingDonationId = byHand.donationId;
    row.action = 'skip';
    row.skipReason = 'hand-entered';
    row.existingBatchName =
      byHand.batchName ?? (byHand.batchId !== null ? `Batch ${byHand.batchId}` : null);
    return row;
  }

  // Contact resolution — email only, matching the sync's rule.
  if (email) {
    const contactId = contacts.get(email.toLowerCase()) ?? null;
    row.mpContactId = contactId;
    row.contactAction = contactId === null ? 'create' : 'match';
  } else {
    row.contactAction = 'create';
    row.problem = 'Donor has no email address — cannot be matched or deduplicated';
  }

  if (row.mpContactId !== null) {
    const donorId = donors.get(row.mpContactId) ?? null;
    row.mpDonorId = donorId;
    row.donorAction = donorId === null ? 'create' : 'match';
  } else {
    row.donorAction = 'create';
  }

  return row;
}
