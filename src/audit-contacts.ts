/**
 * Pre-flight duplicate check.
 *
 * The sync matches donors to MP contacts on email. Anyone already in MP under a
 * different email address would be created as a NEW contact — a duplicate person
 * in a 118k-contact database, which is tedious to unpick after the fact.
 *
 * This reports every donor the sync would create, alongside any same-name MP
 * contacts it found, so a human can decide before the first live run.
 *
 *   node src/audit-contacts.ts
 */
import { mp, sqlStr } from './mp.ts';
import { overflow } from './overflow.ts';
import { config } from './env.ts';

interface Candidate {
  Contact_ID: number;
  Display_Name: string | null;
  Email_Address: string | null;
  Mobile_Phone: string | null;
  Contact_Status_ID: number | null;
}

const norm = (s?: string | null) => (s ?? '').trim().toLowerCase();

async function main(): Promise<void> {
  const contributions = await overflow.contributions(config.syncFromDate);
  const floor = new Date(config.syncFromDate).getTime();

  // One entry per distinct donor, not per gift.
  const donors = new Map<string, { first: string; last: string; email: string; phone: string }>();
  for (const c of contributions) {
    if (new Date(c.contributionDate).getTime() < floor) continue;
    const d = c.donor;
    if (!d?.email) continue;
    const key = norm(d.email);
    if (!donors.has(key)) {
      donors.set(key, {
        first: d.firstName?.trim() ?? '',
        last: d.lastName?.trim() ?? '',
        email: d.email.trim(),
        phone: d.phone?.trim() ?? '',
      });
    }
  }

  console.log(`Auditing ${donors.size} distinct Overflow donors since ${config.syncFromDate}\n`);

  let matched = 0;
  let clean = 0;
  const suspects: string[] = [];

  for (const d of donors.values()) {
    const byEmail = await mp.select<Candidate>(
      'Contacts',
      `$select=Contact_ID&$filter=Email_Address=${encodeURIComponent(sqlStr(d.email))}`,
    );
    if (byEmail.length > 0) {
      matched++;
      continue; // sync will reuse this contact — nothing to review
    }

    // No email match: would create. Look for same-name humans already in MP.
    const filters: string[] = [];
    if (d.last) filters.push(`Last_Name=${sqlStr(d.last)}`);
    if (d.first) filters.push(`First_Name=${sqlStr(d.first)}`);
    if (filters.length === 0) continue;

    const byName = await mp.select<Candidate>(
      'Contacts',
      `$select=Contact_ID,Display_Name,Email_Address,Mobile_Phone,Contact_Status_ID` +
        `&$filter=${encodeURIComponent(filters.join(' AND '))}&$top=10`,
    );

    // Phone is a strong secondary signal when emails differ.
    const digits = (s: string) => s.replace(/\D/g, '').slice(-10);
    const phoneHit = byName.filter(
      (c) => d.phone && c.Mobile_Phone && digits(c.Mobile_Phone) === digits(d.phone),
    );

    if (byName.length === 0) {
      clean++;
      continue;
    }

    suspects.push(
      `\n  ${d.first} ${d.last}  <${d.email}>${d.phone ? `  ${d.phone}` : ''}\n` +
        `    would be CREATED, but MP already has ${byName.length} contact(s) with this name:\n` +
        byName
          .map(
            (c) =>
              `      ${String(c.Contact_ID).padStart(7)}  ${(c.Display_Name ?? '').padEnd(28)} ` +
              `${c.Email_Address ?? '(no email)'}` +
              (phoneHit.some((p) => p.Contact_ID === c.Contact_ID) ? '   ← PHONE MATCH' : ''),
          )
          .join('\n'),
    );
  }

  console.log(`Already in MP by email      : ${matched}`);
  console.log(`New, no same-name contact   : ${clean}`);
  console.log(`New, but same name exists   : ${suspects.length}   ← review these`);
  if (suspects.length) {
    console.log('\n─────────── possible duplicates ───────────');
    console.log(suspects.join('\n'));
    console.log(
      `\nIf any of these are the same person, add the Overflow email to the existing\n` +
        `MP contact, then re-run the sync — it will match and reuse the contact.`,
    );
  }
}

main().catch((err: unknown) => {
  console.error(`FATAL: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
