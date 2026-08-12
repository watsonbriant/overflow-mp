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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  problem: string | null;
}

export interface Plan {
  generatedAt: string;
  since: string;
  syncFromDate: string;
  rows: PlanRow[];
  totals: {
    count: number;
    amount: number;
    toCreate: number;
    toCreateAmount: number;
    alreadyInMp: number;
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

const mappingRaw = JSON.parse(
  readFileSync(join(process.cwd(), 'config/fund-mapping.json'), 'utf8'),
) as { paymentTypes: { names: Record<string, string> } };

const paymentTypeNames = mappingRaw.paymentTypes.names ?? {};

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

export async function buildPlan(sinceIso?: string): Promise<Plan> {
  const since = sinceIso ?? config.syncFromDate;
  const floor = new Date(config.syncFromDate).getTime();

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

  const rows = inScope.map((c) => planOne(c, campuses, donations, contacts, donors));

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
    syncFromDate: config.syncFromDate,
    rows,
    totals: {
      count: rows.length,
      amount: round(rows.reduce((s, r) => s + r.amount, 0)),
      toCreate: toCreate.length,
      toCreateAmount: round(toCreate.reduce((s, r) => s + r.amount, 0)),
      alreadyInMp: rows.filter((r) => r.action === 'skip').length,
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
