/**
 * Finds Overflow gifts that staff have ALREADY entered into MinistryPlatform by
 * hand, and infers where that manual entry stops.
 *
 * Why this exists: the sync's duplicate protection keys on the Overflow
 * contribution id stored in Transaction_Code. A hand-entered donation has no
 * such id, so it is invisible to that check. Syncing a period the team already
 * keyed in would therefore double-post real money to real donor records —
 * the one failure here that cannot be quietly undone.
 *
 * Detection: same donor, same amount, donation date within a tolerance, and no
 * Overflow contribution id on the MP record.
 *
 * Read-only. Never writes.
 *
 *   node src/overlap-check.ts
 */
import { mp, sqlStr } from './mp.ts';
import { overflow, type OverflowContribution } from './overflow.ts';

/** Manual entry often lands on the deposit or service date rather than the gift date. */
const DAY = 24 * 60 * 60 * 1000;
const TOLERANCE_DAYS = 4;

interface MpDonation {
  Donation_ID: number;
  Donor_ID: number;
  Donation_Amount: number;
  Donation_Date: string;
  Transaction_Code: string | null;
  Batch_ID: number | null;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const dayKey = (iso: string) => iso.slice(0, 10);

async function main(): Promise<void> {
  console.log('Fetching all confirmed Overflow contributions…');
  const contributions = await overflow.contributions('2000-01-01T00:00:00Z');
  if (contributions.length === 0) {
    console.log('No contributions returned.');
    return;
  }

  const dates = contributions.map((c) => c.contributionDate).sort();
  console.log(
    `  ${contributions.length} contributions, ${dayKey(dates[0])} → ${dayKey(dates[dates.length - 1])}\n`,
  );

  // Overflow donor email → MP contact → MP donor.
  const emails = [
    ...new Set(
      contributions
        .map((c) => c.donor?.email?.trim().toLowerCase())
        .filter((e): e is string => !!e),
    ),
  ];

  const contactByEmail = new Map<string, number>();
  for (const group of chunk(emails, 40)) {
    const rows = await mp.select<{ Contact_ID: number; Email_Address: string | null }>(
      'Contacts',
      `$select=Contact_ID,Email_Address&$filter=${encodeURIComponent(
        `Email_Address in (${group.map((e) => sqlStr(e)).join(',')})`,
      )}&$orderby=Contact_ID`,
    );
    for (const r of rows) {
      const k = r.Email_Address?.trim().toLowerCase();
      if (k && !contactByEmail.has(k)) contactByEmail.set(k, r.Contact_ID);
    }
  }

  const donorByContact = new Map<number, number>();
  for (const group of chunk([...new Set(contactByEmail.values())], 80)) {
    const rows = await mp.select<{ Donor_ID: number; Contact_ID: number }>(
      'Donors',
      `$select=Donor_ID,Contact_ID&$filter=${encodeURIComponent(
        `Contact_ID in (${group.join(',')})`,
      )}&$orderby=Donor_ID`,
    );
    for (const r of rows) if (!donorByContact.has(r.Contact_ID)) donorByContact.set(r.Contact_ID, r.Donor_ID);
  }

  const donorIds = [...new Set(donorByContact.values())];
  console.log(
    `Matched ${contactByEmail.size}/${emails.length} donor emails to MP contacts, ` +
      `${donorIds.length} with donor records.\n`,
  );
  if (donorIds.length === 0) {
    console.log('No overlapping donors — nothing could have been hand-entered for these people.');
    return;
  }

  // All MP donations for those donors from a bit before the first Overflow gift.
  const windowStart = new Date(new Date(dates[0]).getTime() - TOLERANCE_DAYS * DAY)
    .toISOString()
    .slice(0, 10);

  const mpDonations: MpDonation[] = [];
  for (const group of chunk(donorIds, 60)) {
    const rows = await mp.select<MpDonation>(
      'Donations',
      `$select=Donation_ID,Donor_ID,Donation_Amount,Donation_Date,Transaction_Code,Batch_ID` +
        `&$filter=${encodeURIComponent(
          `Donor_ID in (${group.join(',')}) AND Donation_Date >= '${windowStart}'`,
        )}&$top=2000`,
    );
    mpDonations.push(...rows);
  }
  console.log(`Pulled ${mpDonations.length} MP donations for those donors since ${windowStart}.\n`);

  // Index by donor for cheap lookup.
  const byDonor = new Map<number, MpDonation[]>();
  for (const d of mpDonations) {
    const list = byDonor.get(d.Donor_ID) ?? [];
    list.push(d);
    byDonor.set(d.Donor_ID, list);
  }

  const overflowIds = new Set(contributions.map((c) => c.id));

  interface Hit {
    c: OverflowContribution;
    mp: MpDonation;
  }
  const alreadySynced: Hit[] = [];
  const handEntered: Hit[] = [];
  const notInMp: OverflowContribution[] = [];

  for (const c of contributions) {
    const email = c.donor?.email?.trim().toLowerCase();
    const contactId = email ? contactByEmail.get(email) : undefined;
    const donorId = contactId !== undefined ? donorByContact.get(contactId) : undefined;
    if (donorId === undefined) {
      notInMp.push(c);
      continue;
    }

    const candidates = byDonor.get(donorId) ?? [];
    const target = new Date(c.contributionDate).getTime();

    // Our own prior sync, if any.
    const synced = candidates.find((d) => d.Transaction_Code === c.id);
    if (synced) {
      alreadySynced.push({ c, mp: synced });
      continue;
    }

    // Same amount, close date, and NOT tagged with any Overflow id.
    const manual = candidates.find(
      (d) =>
        Math.abs(d.Donation_Amount - c.amount) < 0.005 &&
        Math.abs(new Date(d.Donation_Date).getTime() - target) <= TOLERANCE_DAYS * DAY &&
        !(d.Transaction_Code && overflowIds.has(d.Transaction_Code)),
    );

    if (manual) handEntered.push({ c, mp: manual });
    else notInMp.push(c);
  }

  /* ----------------------------------------------------------------- report */

  console.log('═══ RESULT ═══\n');
  console.log(`Already synced by us (has Overflow id)     : ${alreadySynced.length}`);
  console.log(`Look ALREADY HAND-ENTERED in MP            : ${handEntered.length}   ← duplicate risk`);
  console.log(`No match in MP                             : ${notInMp.length}\n`);

  if (handEntered.length > 0) {
    const byDay = new Map<string, { n: number; amount: number }>();
    for (const h of handEntered) {
      const k = dayKey(h.c.contributionDate);
      const cur = byDay.get(k) ?? { n: 0, amount: 0 };
      byDay.set(k, { n: cur.n + 1, amount: cur.amount + h.c.amount });
    }
    const days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));

    console.log('Apparent hand-entered gifts by contribution date:');
    for (const [day, v] of days) {
      console.log(`  ${day}   ${String(v.n).padStart(3)} gifts   $${v.amount.toFixed(2)}`);
    }

    const last = days[days.length - 1][0];
    console.log(`\n  ⚠ Manual entry appears to run through ${last}.`);
    console.log(`    Setting SYNC_FROM_DATE later than ${last} avoids double-posting.`);

    // Concrete records to spot-check in MP, newest first — a heuristic cutoff
    // should be confirmed against the actual donations before it's trusted.
    const newest = handEntered
      .slice()
      .sort((a, b) => b.c.contributionDate.localeCompare(a.c.contributionDate))
      .slice(0, 12);

    console.log('\n  Verify these in MinistryPlatform (Donations → Donation_ID):');
    console.log(
      '    MP Donation   Amount   MP date     Overflow date  Batch   Overflow contribution',
    );
    for (const h of newest) {
      console.log(
        `    ${String(h.mp.Donation_ID).padStart(11)}   ` +
          `$${h.c.amount.toFixed(2).padStart(7)}  ` +
          `${dayKey(h.mp.Donation_Date)}  ${dayKey(h.c.contributionDate)}     ` +
          `${String(h.mp.Batch_ID ?? '—').padStart(5)}   ${h.c.id}`,
      );
    }
  }

  // Where does un-entered data begin? That is the safe sync start.
  if (notInMp.length > 0) {
    const firstUnentered = notInMp
      .map((c) => dayKey(c.contributionDate))
      .sort()[0];
    console.log(`\n  Earliest Overflow gift with no MP match: ${firstUnentered}`);
  }

  console.log(
    `\nDetection is heuristic: donor + amount + date within ${TOLERANCE_DAYS} days. ` +
      `Confirm a sample in MP before trusting the cutoff.`,
  );
}

main().catch((err: unknown) => {
  console.error(`FATAL: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
