# Overflow → MinistryPlatform sync

One-way sync of confirmed [Overflow.co](https://overflow.co) giving into Freedom
House's MinistryPlatform. Zero dependencies; runs on Node 23+ (TypeScript is
executed natively, no build step).

```bash
node src/audit-contacts.ts     # pre-flight: find likely duplicate people
node src/cli.ts --dry-run --all # report what would be written; no writes
node src/cli.ts --limit=1       # first live run, one gift
node src/cli.ts                 # normal incremental run
```

## Setup

`cp .env.example .env` and fill in:

| Key | Notes |
|---|---|
| `MP_CLIENT_SECRET` | from Administration → API Clients |
| `OVERFLOW_CLIENT_ID` / `OVERFLOW_API_KEY` | sent as `x-client-id` / `x-api-key` |
| `SYNC_FROM_DATE` | hard floor; gifts before this are ignored entirely |
| `MP_HOUSEHOLD_SOURCE_ID` | stamped on households the sync creates |

`.env` and `state/` are gitignored. **Never commit the secret** — MP stores it
hashed and cannot show it again, so a leak means rotating it.

## How it maps

Overflow's `campaign` is the **campus**; `subcampaign` is the **fund**.
`locationId` is useless here — every gift carries the same "Default" location.

MinistryPlatform has no campus on a donation. Campus is encoded in the
**Program**, which carries its own `Congregation_ID`. So funds are keyed on
**(campaign + subcampaign)** → `Program_ID`, never subcampaign alone: four
subcampaign ids (`General Fund (Tithe)`, `Liberty`, `Outreach + Missions`,
`Freedom Academy`) are reused verbatim across all four campuses.

| Campus | Congregation | Tithe | Kingdom Builders | Liberty |
|---|---|---|---|---|
| Central | 1 | 6 | 195 | 209 |
| South End | 5 | 81 | 198 | 210 |
| Lake Norman | 4 | 50 | 196 | 211 |
| Ballantyne | 7 | 213 | 199 | 215 |

`Freedom Academy` → 32 and `Outreach + Missions` → 55 are single churchwide
programs by decision (2026-08-12); campus attribution is intentionally not
preserved for those two.

Full table with ids: `config/fund-mapping.json`.

### Annual maintenance ⚠️

MP programs are year-scoped (`Liberty 2026`, `Kingdom Builders '25-'26`);
Overflow subcampaigns are not (`Liberty`). **This mapping goes stale every
year.** `assertProgramsOpen()` refuses to run once a target program's
`End_Date` has passed, rather than posting into a closed fund where nobody
would notice until reconciliation. When it fails, update
`config/fund-mapping.json` to the new program ids.

## Safety properties

- **Idempotent.** Every donation stores its Overflow contribution id in
  `Transaction_Code`, checked before insert. Re-running never double-posts.
- **Self-healing.** A donation whose distribution insert failed previously is
  repaired on the next run.
- **Fails loudly.** Unmapped fund, unknown payment type, closed program, or
  ambiguous contact match all stop that gift with an explanation. Nothing is
  guessed — a wrong `Payment_Type_ID` or `Program_ID` corrupts finance
  reporting silently, which is worse than a visible failure.
- **Watermark only advances on a clean run.** Failures retry next time.
- **No deletes, ever.** The MP role grants Edit, not Full, and the service
  user has `Delete Permitted = No`.

## Contact matching

Overflow and OnlineGiving.org both write people into MP, so the priority is
avoiding a third duplicate:

1. **Email** exact match. One hit wins.
2. Several hits (shared household email) → narrow by first + last name.
3. No email hit → **first + last name AND matching phone** (last 10 digits).
   Donors often give with a personal email while MP has their work address.
4. Still nothing → create Household + Contact, stamped with
   `Household_Source_ID` so machine-created records stay traceable.

Name alone is never sufficient. Ambiguity throws rather than guesses.

Run `src/audit-contacts.ts` before any live run. On 2026-08-12 it caught five
same-name/different-email donors; four were confirmed by phone and are now
matched automatically, one (`Abigail Croom`) needs a human decision.

## Hosting the preview (Netlify)

The preview renders real donor names, email addresses, and gift amounts. It must
never be openly reachable.

`netlify/edge-functions/password-gate.ts` gates the whole site behind a
single-password form, on any Netlify plan. Not Basic Auth — that always renders a
username field the viewer has to guess at. Entering the password sets an
HttpOnly/Secure cookie holding an HMAC derived from it, so the cookie cannot be
forged without the password; it is recomputed and compared on every request.

Required Netlify environment variables:

| Key | Notes |
|---|---|
| `PREVIEW_PASSWORD` | the shared password; **required** — without it the site locks, not opens |
| `MP_DOMAIN`, `MP_CLIENT_ID`, `MP_CLIENT_SECRET` | as in `.env` |
| `OVERFLOW_BASE`, `OVERFLOW_CLIENT_ID`, `OVERFLOW_API_KEY` | as in `.env` |
| `MP_HOUSEHOLD_SOURCE_ID`, `SYNC_FROM_DATE` | optional; sensible defaults in code |

`.env` is gitignored and therefore absent on Netlify — the platform's own
environment variables are the only source there. Two deploy-only pitfalls that
are invisible locally, both already fixed, worth not reintroducing:

- Never reference `.env` via `new URL('…', import.meta.url)`. Turbopack resolves
  that statically as an asset and the **build fails** when the file is absent.
  Build the path at runtime instead.
- Read `config/fund-mapping.json` via a JSON **import**, not `fs` + `cwd`. A
  bundled serverless function has no reliable working directory.

## Not yet implemented: batches and deposits

Contributions post with `Batch_ID: null`, matching how OnlineGiving.org
behaves. Grouping them into MP Batches + Deposits per Overflow payout is
deliberately deferred, because of a unit and semantics mismatch:

- contribution `amount` is **gross, in dollars**
- deposit `amountInCents` is the **net payout, in cents**

So the sum of gross gifts will not equal the bank deposit once processing fees
are involved, and MP's Donation/Batch tables have no fee column. Creating a
batch that doesn't tie to the bank is worse than creating none. **Open question
for finance: how should Overflow's processing fees be represented?**

## Layout

```
config/fund-mapping.json   campus, fund, and payment-type mappings
src/env.ts                 .env reader (never sources the file — secrets contain ; ^ $)
src/mp.ts                  MinistryPlatform client, token caching
src/overflow.ts            Overflow client, pagination
src/mapping.ts             fund + payment type resolution, program validation
src/sync.ts                contact → donor → donation → distribution
src/cli.ts                 entry point, watermark
src/audit-contacts.ts      duplicate-person pre-flight
scripts/mp.sh              ad-hoc read:  ./scripts/mp.sh '/tables/Donations?$top=1'
scripts/of.sh              ad-hoc read:  ./scripts/of.sh '/api/v3/campaigns'
scripts/verify-mp.sh       credential + permission check
```
