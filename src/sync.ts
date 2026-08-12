import { mp, mpDateTime, sqlStr } from './mp.ts';
import { overflow, type OverflowContribution, type OverflowDonor } from './overflow.ts';
import { MappingError, assertProgramsOpen, policy, resolveFund, resolvePaymentType } from './mapping.ts';
import { config } from './env.ts';

export interface SyncOptions {
  dryRun: boolean;
  since: string;
  /** Stop after N contributions. Useful for a cautious first live run. */
  limit?: number;
}

export interface SyncResult {
  considered: number;
  created: number;
  skipped: number;
  repaired: number;
  failed: { id: string; reason: string }[];
}

const log = (msg: string) => console.log(msg);

/* ------------------------------------------------------------------ donors */

/**
 * Contact matching is email-only, by decision (2026-08-12): one deterministic
 * rule rather than per-donor judgement calls. No email match ⇒ create a new MP
 * contact.
 *
 * Known trade-off: a donor who gives through Overflow with a personal address
 * while MP holds their work address becomes a second contact record, splitting
 * their giving history. `src/audit-contacts.ts` reports these so staff can
 * merge them in MP (Tools → Combine Contacts) — it is a reporting problem to
 * clean up, not a reason to guess at identity during the sync.
 */
async function findContact(donor: OverflowDonor): Promise<number | null> {
  const email = donor.email?.trim();
  if (!email) {
    // No matchable key at all. Create, but say so — repeat gifts from this
    // donor cannot be deduplicated and will each produce a contact.
    console.warn(
      `      ! donor ${donor.id} has no email — creating an unmatchable contact`,
    );
    return null;
  }

  const candidates = await mp.select<{
    Contact_ID: number;
    First_Name: string | null;
    Last_Name: string | null;
  }>(
    'Contacts',
    `$select=Contact_ID,First_Name,Last_Name` +
      `&$filter=Email_Address=${encodeURIComponent(sqlStr(email))}` +
      `&$orderby=Contact_ID`,
  );

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].Contact_ID;

  // Shared household email (spouses) is common. Narrow on name before giving up.
  const eq = (a?: string | null, b?: string | null) =>
    !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

  let narrowed = candidates.filter(
    (c) => eq(c.Last_Name, donor.lastName) && eq(c.First_Name, donor.firstName),
  );
  if (narrowed.length !== 1) {
    narrowed = candidates.filter((c) => eq(c.First_Name, donor.firstName));
  }
  if (narrowed.length === 1) return narrowed[0].Contact_ID;

  throw new MappingError(
    `Email ${email} matches ${candidates.length} MP contacts ` +
      `(${candidates.map((c) => c.Contact_ID).join(', ')}) and the name ` +
      `"${donor.firstName ?? ''} ${donor.lastName ?? ''}".trim() did not ` +
      `disambiguate. Merge or correct them in MP, then re-run.`,
  );
}

async function createContact(donor: OverflowDonor, dryRun: boolean): Promise<number> {
  const first = donor.firstName?.trim() || null;
  const last = donor.lastName?.trim() || null;
  const displayName = [last, first].filter(Boolean).join(', ') || donor.email || donor.id;

  if (dryRun) {
    log(`      would CREATE household + contact "${displayName}"`);
    return -1;
  }

  const [household] = await mp.insert<{ Household_ID: number }>('Households', [
    {
      Household_Name: last ?? displayName,
      Household_Source_ID: config.householdSourceId,
      Congregation_ID: null,
    },
  ]);

  const [contact] = await mp.insert<{ Contact_ID: number }>('Contacts', [
    {
      Company: false,
      Display_Name: displayName,
      First_Name: first,
      Last_Name: last,
      Nickname: first,
      Contact_Status_ID: 1,
      Household_ID: household.Household_ID,
      Household_Position_ID: 1,
      Email_Address: donor.email?.trim() || null,
      Mobile_Phone: donor.phone?.trim() || null,
    },
  ]);

  log(`      created contact ${contact.Contact_ID} "${displayName}"`);
  return contact.Contact_ID;
}

async function findOrCreateDonor(contactId: number, dryRun: boolean): Promise<number> {
  if (contactId === -1) return -1; // dry-run placeholder contact

  const existing = await mp.select<{ Donor_ID: number }>(
    'Donors',
    `$select=Donor_ID&$filter=Contact_ID=${contactId}&$orderby=Donor_ID`,
  );
  if (existing.length > 0) return existing[0].Donor_ID;

  if (dryRun) {
    log(`      would CREATE donor record for contact ${contactId}`);
    return -1;
  }

  // Mirrors the statement settings on existing donor records in this instance.
  const [donor] = await mp.insert<{ Donor_ID: number }>('Donors', [
    {
      Contact_ID: contactId,
      Statement_Frequency_ID: 1,
      Statement_Type_ID: 2,
      Statement_Method_ID: 1,
      Setup_Date: mpDateTime(new Date().toISOString()),
    },
  ]);
  log(`      created donor ${donor.Donor_ID} for contact ${contactId}`);
  return donor.Donor_ID;
}

/* --------------------------------------------------------------- donations */

function buildNotes(c: OverflowContribution): string {
  const d = c.donor;
  const pm = c.paymentMethod;
  return [
    `First Name: ${d?.firstName ?? ''}`,
    `Last Name: ${d?.lastName ?? ''}`,
    `Phone: ${d?.phone ?? ''}`,
    `Email: ${d?.email ?? ''}`,
    `Gift Type: ${c.frequency === 'one-time' ? 'One Time' : (c.frequency ?? '')}`,
    `Fund: ${c.campaign?.name ?? ''} / ${c.subcampaign?.name ?? ''}`,
    `Payment: ${pm?.type ?? ''}${pm?.last4 ? ` ****${pm.last4}` : ''}`,
    `Overflow Contribution: ${c.id}`,
    `Overflow Status: ${c.status}`,
    `Gift Source: Overflow`,
    c.donorNotes ? `Donor Notes: ${c.donorNotes}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

async function findDonationByOverflowId(overflowId: string): Promise<number | null> {
  const rows = await mp.select<{ Donation_ID: number }>(
    'Donations',
    `$select=Donation_ID&$filter=Transaction_Code=${encodeURIComponent(sqlStr(overflowId))}`,
  );
  return rows[0]?.Donation_ID ?? null;
}

async function hasDistribution(donationId: number): Promise<boolean> {
  const rows = await mp.select<{ Donation_Distribution_ID: number }>(
    'Donation_Distributions',
    `$select=Donation_Distribution_ID&$filter=Donation_ID=${donationId}&$top=1`,
  );
  return rows.length > 0;
}

/* ---------------------------------------------------------------- per-gift */

type Outcome = 'created' | 'skipped' | 'repaired';

async function syncOne(c: OverflowContribution, dryRun: boolean): Promise<Outcome> {
  const fund = resolveFund(c);
  const paymentTypeId = resolvePaymentType(c);

  const existingId = await findDonationByOverflowId(c.id);
  if (existingId !== null) {
    // Self-heal a donation whose distribution insert failed on a previous run.
    if (await hasDistribution(existingId)) return 'skipped';

    log(`    donation ${existingId} exists but has no distribution — repairing`);
    if (!dryRun) {
      await mp.insert('Donation_Distributions', [
        { Donation_ID: existingId, Amount: c.amount, Program_ID: fund.programId, Notes: buildNotes(c) },
      ]);
    }
    return 'repaired';
  }

  if (!c.donor) throw new MappingError(`Contribution ${c.id} has no donor object`);

  const contactId = (await findContact(c.donor)) ?? (await createContact(c.donor, dryRun));
  const donorId = await findOrCreateDonor(contactId, dryRun);

  const donation = {
    Donor_ID: donorId,
    Donation_Amount: c.amount,
    Donation_Date: mpDateTime(c.contributionDate),
    Payment_Type_ID: paymentTypeId,
    Item_Number: c.paymentMethod?.type ?? null,
    Batch_ID: null, // batched later, against the real bank deposit
    Notes: buildNotes(c),
    Anonymous: c.anonymous ?? false,
    Transaction_Code: c.id, // idempotency key
    Gateway_Response: `Overflow:${c.status}`,
    Processed: true,
    Currency: 'USD',
    Receipted: false,
    Invoice_Number: `${policy.invoiceNumberPrefix}-${c.id}`,
    Multiple_Donor_Match: false,
  };

  if (dryRun) {
    log(
      `      would CREATE donation $${c.amount.toFixed(2)} ` +
        `→ program ${fund.programId} (${fund.programName}), ` +
        `payment type ${paymentTypeId}, donor ${donorId === -1 ? '(new)' : donorId}`,
    );
    return 'created';
  }

  const [created] = await mp.insert<{ Donation_ID: number }>('Donations', [donation]);
  await mp.insert('Donation_Distributions', [
    { Donation_ID: created.Donation_ID, Amount: c.amount, Program_ID: fund.programId, Notes: buildNotes(c) },
  ]);

  log(
    `      donation ${created.Donation_ID}  $${c.amount.toFixed(2)}  ` +
      `→ ${fund.programName} (${fund.programId})`,
  );
  return 'created';
}

/* ---------------------------------------------------------------- run loop */

export async function sync(opts: SyncOptions): Promise<SyncResult> {
  const result: SyncResult = { considered: 0, created: 0, skipped: 0, repaired: 0, failed: [] };

  log(`Overflow → MinistryPlatform sync${opts.dryRun ? '  [DRY RUN — no writes]' : ''}`);
  log(`  updated since: ${opts.since}`);

  let contributions = await overflow.contributions(opts.since);

  // Hard floor against back-filling gifts OnlineGiving.org already posted.
  const floor = new Date(config.syncFromDate).getTime();
  const beforeFloor = contributions.length;
  contributions = contributions.filter(
    (c) => new Date(c.contributionDate).getTime() >= floor,
  );
  const dropped = beforeFloor - contributions.length;
  if (dropped > 0) {
    log(`  ignored ${dropped} contribution(s) dated before SYNC_FROM_DATE (${config.syncFromDate})`);
  }

  if (opts.limit !== undefined) contributions = contributions.slice(0, opts.limit);
  log(`  ${contributions.length} confirmed contribution(s) to process\n`);
  if (contributions.length === 0) return result;

  // Validate every target program up front, so a stale mapping fails before
  // any money is written rather than halfway through the batch.
  const programIds: number[] = [];
  for (const c of contributions) {
    try {
      programIds.push(resolveFund(c).programId);
    } catch {
      /* reported per-contribution below */
    }
  }
  await assertProgramsOpen(programIds);

  for (const c of contributions) {
    result.considered++;
    const label = `${c.contributionDate.slice(0, 10)}  $${c.amount.toFixed(2).padStart(9)}  ${c.id}`;
    try {
      const outcome = await syncOne(c, opts.dryRun);
      result[outcome]++;
      if (outcome === 'skipped') log(`  ⏭  ${label}  already in MP`);
      else log(`  ✓  ${label}`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      result.failed.push({ id: c.id, reason });
      log(`  ✗  ${label}\n       ${reason}`);
    }
  }

  return result;
}
