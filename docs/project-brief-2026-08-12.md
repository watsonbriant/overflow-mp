# Overflow → MinistryPlatform Integration
## Project brief — 12 August 2026

Source material for a stakeholder-facing document. Every figure below was
measured against live data on 12 Aug 2026, not estimated.

---

## 1. In one paragraph

Freedom House accepts giving through Overflow.co. Those gifts were not reaching
MinistryPlatform, so donor records, fund totals, and contribution statements did
not reflect them. We built a one-way sync that reads confirmed Overflow
contributions and writes them into MinistryPlatform as donations attached to the
right donor, fund, and campus. The sync is complete and verified against live
data. **Nothing has been written to MinistryPlatform yet** — it is waiting on
stakeholder approval.

## 2. Status at end of day

| Item | Status |
|---|---|
| MinistryPlatform API access + permissions | Complete, verified |
| Overflow API access | Complete, verified |
| Fund and campus mapping (all 24 combinations) | Complete, built from live data |
| Sync engine | Complete, dry-run clean |
| Stakeholder preview website | Complete |
| **Writes to MinistryPlatform** | **None. Zero records created or modified.** |
| Hosted on Netlify, password protected | Deployed 12 Aug 2026 |
| Batches / bank deposit reconciliation | Deliberately deferred — see §8 |
| Automatic scheduling | Not yet decided |

## 3. What the preview shows today

| Measure | Value |
|---|---|
| **Gifts ready to transfer** | **20** |
| **Total value** | **$1,768.00** |
| Date range | 3 Aug 2026 onward — after the manual-entry cutoff (see §9) |
| Blocked / needing a human decision | 0 |
| New donor records to create in MP | 2 |
| New people (contacts) to create in MP | 9 |
| Already entered by hand by staff, deliberately excluded | 125 gifts, $17,773.24, in 15 batches |
| Overflow contributions on record, all time | 145 |
| Overflow bank payouts on record | 16 |
| Existing contacts in MinistryPlatform | ~118,000 |

The preview also offers an **all-history** view for context. It reports 49 gifts
($3,810.70) that appear absent from MinistryPlatform across all Overflow history —
but only 20 of those ($1,768.00) fall after the manual-entry cutoff. The
difference is covered in §9, item 1.

## 4. Systems and resources used

| System | Address | Role |
|---|---|---|
| MinistryPlatform | `freedomhouse.ministryplatform.com` | Destination — church database of record |
| MinistryPlatform REST API | `/ministryplatformapi` | Read/write interface |
| Overflow | `server.overflow.co` | Source — giving platform |
| Overflow API docs | `docs.overflow.co` | Reference |
| MinistryPlatform docs | `help.acst.com`, `kb.ministryplatform.com` | Reference |
| Code repository | `github.com/watsonbriant/overflow-mp` (**private**) | Version control |
| Netlify | preview site (**password protected**) | Hosting for stakeholder review |

## 5. What we created in MinistryPlatform

Four new records, in this order. Nothing existing was modified.

**1. Service contact** — Administration → People → Tools → Add/Edit Company
- Name: `Overflow: API` (matches the existing `ACST:` vendor-account convention)
- Type: Company · Status: Active · Campus: All Campuses
- Created Contact `118198`, Household `92290`
- Deliberately **not** given a donor record, so mis-posted gifts cannot land on it
- Deliberately given no email address, so it cannot be swept into bulk mailings

**2. Service user** — Administration → Users
- Username `overflow.api`, Display Name `Overflow API`, User Account `5481`
- Admin: No · Setup Admin: No · Can Impersonate: No
- Data Service Permissions: Read **Yes**, Create **Yes**, Update **Yes**, Delete **No**

**3. Security role** — Administration → Security Roles
- Name: `Overflow Integration`, type Custom/Individual
- Mass Email Quota `0` and Mass Text Quota `0` — cannot message the congregation
- Permissions granted, and nothing else:

| Page | Access |
|---|---|
| People (Contacts) | Edit |
| Households | Edit |
| Donors | Edit |
| Donations | Edit |
| Donation Distributions | Edit |
| Batches | Edit |
| Deposits | Edit |
| Programs (funds) | **Read only** |
| Campuses (Congregations) | **Read only** |
| Batch Types | **Read only** |

**4. API client** — Administration → API Clients
- Display Name `Overflow Integration`, Client ID `overflow_integration`
- Authentication Flow: Client Credentials · Access Token Lifetime 60 min
- Client User: `Overflow: API`

**5. Lookup value added** — Lookup Values → Household Sources
- `Overflow` = ID `38`, stamped on every household the sync creates so
  machine-created records are always identifiable and reversible

## 6. Reference IDs confirmed from the live system

**Campuses (Congregations)**

| ID | Campus |
|---|---|
| 1 | Central |
| 2 | Friends & Internet |
| 3 | Online |
| 4 | Lake Norman |
| 5 | South End |
| 6 | Offsite |
| 7 | Ballantyne |
| 9 | All Campuses |

**Payment types** — note these are *not* MinistryPlatform's default ordering,
which is why we queried rather than assumed

| ID | Type |
|---|---|
| 1 | Check |
| 2 | Cash |
| 3 | Coin |
| 4 | Credit Card |
| 5 | ACH/EFT |
| 6 | Non-Cash/Asset |

## 7. How the mapping works

Two findings shaped the entire design:

**In Overflow, the campaign is the campus and the subcampaign is the fund.**
Overflow's own "location" field is unusable — every gift carries the same
"Default" location.

**In MinistryPlatform, a donation carries no campus.** Campus lives in the
*Program* (the fund). Identically-named funds are duplicated per campus, so
choosing the wrong one puts a Lake Norman gift in Central's books.

Therefore funds are matched on **campaign + subcampaign together**, never
subcampaign alone — four subcampaign IDs are reused verbatim across all four
campuses.

| Campus | Congregation | Tithe fund | Kingdom Builders | Liberty |
|---|---|---|---|---|
| Central | 1 | 6 | 195 | 209 |
| South End | 5 | 81 | 198 | 210 |
| Lake Norman | 4 | 50 | 196 | 211 |
| Ballantyne | 7 | 213 | 199 | 215 |

Two funds are churchwide rather than per-campus:
- **Freedom Academy** → Program 32 (books to Central)
- **Outreach + Missions** → Program 55 (books to Offsite)

All 24 campaign × fund combinations are mapped and verified.

## 8. Decisions made today, and why

**Contact matching is email-only.** If an Overflow donor's email matches a MP
contact, that contact is reused. If not, a new one is created. One deterministic
rule instead of case-by-case judgement. *Trade-off accepted:* a donor who gives
through Overflow with a personal address while MP holds their work address
becomes a second contact record. We built a report that finds these so staff can
merge them in MP (Tools → Combine Contacts).

**Freedom Academy and Outreach + Missions stay as single churchwide funds.** The
alternative was creating per-campus versions of both. *Consequence:* see §9.

**Overflow runs alongside OnlineGiving.org indefinitely**, rather than replacing
it. OnlineGiving.org is live and posting daily. This is the most demanding of the
options and drove three requirements: per-source duplicate protection, contact
matching that won't race the other integration into duplicate people, and
separate batch naming so finance reconciles two clean streams.

**Bank deposits and batches are deliberately not built yet.** Overflow reports
gift amounts as **gross dollars** but bank payouts as **net cents** — the two
will not reconcile once processing fees are involved, and MinistryPlatform's
donation and batch tables have no field for fees. A batch that doesn't tie to the
bank is worse than no batch. **Open question for finance: how should Overflow's
processing fees be represented?** Gifts post correctly without batches in the
meantime; donor records and statements work.

**A hard start date is enforced: 3 August 2026.** Gifts dated earlier are ignored
entirely. This is the single most important safety setting in the project,
because it is what prevents re-posting the 125 gifts the finance team already
entered by hand. It must be revisited if manual entry continues — see §9.

## 9. Findings that warrant stakeholder attention

**1. The finance team has been entering Overflow gifts by hand, and we found
exactly where that stops.** This was the most consequential discovery of the day.
MinistryPlatform contains 15 batches named "<date> Overflow" — **125 gifts,
$17,773.24, running 21 May to 2 August 2026**.

This mattered urgently, because the sync's duplicate protection works by reading
the Overflow contribution ID stored on each donation it creates. A hand-entered
donation has no such ID, so it is **invisible to that check**. Our first
configuration would have started from 1 August and re-posted the 2 August batch —
13 gifts, $1,192 — as duplicates against real donor records. The sync's start
date is now set to 3 August, after the last manual batch.

Two things follow from this:

- **The manual cutoff must be confirmed with the finance team.** We inferred 2
  August from batch contents. If anyone keys in gifts after that date, the sync's
  start date has to move with it, or those gifts will post twice.
- **Roughly $2,042 across 29 older gifts appears never to have been entered.**
  Comparing all Overflow history against MinistryPlatform, 49 gifts look absent,
  but only 20 fall after the cutoff. The other 29 predate it and should have been
  keyed in but were not found. This is a heuristic comparison and needs
  verification before anyone acts on it — but if it holds, it is giving that
  never reached the church's books.

**2. Ballantyne's books understate its giving.** Ballantyne generates the most
gifts of any campus, but a substantial share books elsewhere. In the current
window, **$535 of $1,768 — 7 of 20 gifts — books to a different campus than it
was given at**, because Freedom Academy and Outreach + Missions are churchwide
funds:

| Campus | Given at | Books to |
|---|---|---|
| Central | 5 gifts, $750 | 9 gifts, $985 |
| Ballantyne | 7 gifts, $460 | 2 gifts, $125 |
| Lake Norman | 4 gifts, $288 | 4 gifts, $288 |
| South End | 4 gifts, $270 | 3 gifts, $170 |
| Offsite | — | 2 gifts, $200 |

Ballantyne raises $460 and is credited with $125. This is the direct consequence
of the decision in §8 and is reversible by creating per-campus versions of those
two funds. Per-campus giving reports will be off by this amount until then.

**3. South End's tithe traffic is going to the wrong fund in Overflow.** Overflow
offers both a generic "General Fund (Tithe)" and a campus-specific "SE General
Fund (Tithe)", and donors are almost entirely using the generic one. The sync
routes both correctly, so no money is misplaced — but the duplicate options
should be cleaned up in Overflow to reduce donor confusion. The same duplication
exists for every campus.

**4. Five likely duplicate people were caught before any data was written.** A
pre-flight check found five Overflow donors with the same name as an existing MP
contact but a different email address; four also matched on phone number. Under
the email-only rule these will be created as new contacts and need merging in MP.
Had we written data without checking, those five people would each have had two
records with giving history split between them, which quietly breaks year-end
contribution statements.

**5. A second live integration already holds full admin rights.** The existing
`onlinegiving` service account carries the Administrators role. Not urgent and
not something we changed, but worth knowing: the Overflow account was
deliberately built to a much narrower permission set instead of repeating that
pattern.

## 10. Safety properties built in

- **Cannot double-post.** Every donation records its Overflow contribution ID.
  The sync checks for it before writing, so re-running is always safe.
- **Cannot delete.** The service user has Delete disabled, and the role grants
  edit rather than full control.
- **Fails loudly, never guesses.** An unmapped fund, unknown payment type,
  closed fund, or ambiguous contact stops that gift with an explanation. A wrong
  fund or payment type would corrupt finance reporting silently, which is worse
  than a visible failure.
- **Self-healing.** A gift whose second write failed is repaired on the next run.
- **Retries safely.** The progress marker only advances after a clean run.
- **The preview cannot write.** It is built on a separate read-only code path
  that has no access to write functions at all — not merely configured not to.
- **Annual safeguard.** MinistryPlatform funds are year-scoped (`Liberty 2026`)
  while Overflow's are not (`Liberty`), so the mapping goes stale every year. The
  sync refuses to run once a target fund's end date has passed, rather than
  posting into a closed fund where nobody would notice until reconciliation.

## 11. The preview website

A local website showing exactly what would transfer, for review before going
live. Contents:

- Total that would transfer, and gift count
- Gifts to transfer · already in MP · new people to create · needing attention
- Giving by campus, based on where donors actually gave
- A plain-language callout quantifying the churchwide-fund reattribution
- Totals by MinistryPlatform fund, with fund IDs
- Every gift line by line: date, amount, donor, Overflow fund, destination MP
  fund, payment type, whether the contact is new
- A banner stating that nothing has been written

Built with Next.js and hosted on Netlify. **The site is password protected.**
Because the page displays real donor names, email addresses, and gift amounts, a
gate runs ahead of every request and denies access by default — if the password
is ever unset or misconfigured, the site locks rather than exposing data. The
password is stored in Netlify's environment, not in the codebase.

Please do not forward the URL and password outside this stakeholder group.

## 12. Open items and ownership

| # | Item | Owner |
|---|---|---|
| 0 | **Confirm the manual-entry cutoff date (we infer 2 Aug 2026) and confirm manual entry has stopped.** Blocks going live — this is what prevents duplicate postings. | Finance |
| 0b | **Verify whether ~$2,042 across 29 older gifts really is missing from MP** (§9, item 1) | Finance |
| 1 | Review the preview and approve going live | Stakeholders |
| 2 | Decide how Overflow processing fees should be represented, so batches and bank reconciliation can be built | Finance |
| 3 | Decide whether Freedom Academy and Outreach + Missions should become per-campus funds (see §9) | Finance / campus pastors |
| 4 | Clean up duplicate tithe funds in Overflow | Whoever administers Overflow |
| 5 | Merge the five duplicate contacts in MP after the first run | Church database staff |
| 6 | Choose where the sync runs on a schedule | Technical |
| 7 | First live run — a single gift, inspected in MP before opening up | Technical |

## 13. Credentials — location, not values

Secret values are deliberately excluded from this document.

| Credential | Where it lives |
|---|---|
| MinistryPlatform client secret | Local `.env`, excluded from version control |
| Overflow API key | Local `.env`, excluded from version control |
| MinistryPlatform Client ID | `overflow_integration` (not secret) |

The MinistryPlatform secret is stored hashed by MinistryPlatform and cannot be
retrieved after creation — only regenerated. When the sync moves to hosted
infrastructure, both secrets go into that platform's environment-variable store,
never into the repository. The repository was verified after upload to confirm no
credential files were included.

---

### Note for the document designer

- Lead with §1 and §2 — most readers need only those.
- §9 is the section that should prompt discussion; give it visual weight. Item 1
  (manual entry and the cutoff date) is the most important thing in the document
  after "nothing has been written yet".
- §3 numbers work well as large figures. The Ballantyne comparison in §9
  ($460 given vs $125 booked) is the single most useful chart on the page.
- §12 is the call to action.
- §5–§7 are appendix material; keep them but let them recede.
- Please preserve the "nothing has been written yet" statement prominently — it
  is the most important fact for a reader to leave with.
