# Bloomerang to Salesforce migration review

Review of `Upsert.py` and `field_mapping.csv` for a small nonprofit cutover. The job is designed for one full load plus occasional refreshes while both systems run.

**Files reviewed:** `Upsert.py`, `field_mapping.csv`  
**Review date:** 31 August 2026  
**Code updates:** applied in `Upsert.py` the same day (see the two right-hand columns in the summary table).

## Verdict

Several of the original critical risks are now guarded in `Upsert.py`: production writes need `--production`, notes that already exist are skipped by Title, recurring schedules that already exist keep their Salesforce Type, pledges are merged into GiftCommitment, and export IDs are read as text.

A live **refresh still overwrites mapped Salesforce fields** with whatever Bloomerang exported that day. That is not something the script can guess. You still need a written dual-run rule, a sandbox rehearsal, and the Salesforce setup items listed below (Person Account vs Household, the designation external ID, WeGive IDs, household membership).

## What works well

Load order is right: accounts first, then campaigns and funds, then contact points and commitments, then gifts and soft credits. Dry-run can validate transforms without credentials. Bulk API 2.0 error CSVs and the twice-monthly todo file are useful. Communication restrictions and refund notes are handled in code where the CSV language cannot express them.

The script now also writes `reconciliation.csv` (source counts and gift dollar sums versus prepared rows) so you can tie out before trusting Salesforce.

---

## Critical

### 1. The default Salesforce login is production

Originally `SF_DOMAIN` defaulted to `login`. A mistyped command could write into the live org.

**How it was fixed:** Live runs now default to sandbox (`SF_DOMAIN=test`). Production username/password login, or a production instance URL with a session id, raises an error unless you pass `--production`.

**What we still need to do:** For every rehearsal, set sandbox credentials and omit `--production`. When you are ready for the live org, pass `--production` deliberately and confirm the username or instance URL first.

### 2. Notes are inserted every time, never matched

ContentNote has no external ID. The title embeds `[BM-{id}]`, but the code never looked that up, so every re-run duplicated notes.

**How it was fixed:** Before insert, the script queries existing ContentNote titles. Titles already in Salesforce are skipped. If that query fails, notes are **not** inserted, so we do not duplicate in the dark. `--since` still only limits which notes are *considered*; it is not a general delta pipeline.

**What we still need to do:** Nothing further in code for duplicates. Notes are still inserts, not updates, so a note that changed in Bloomerang after the first load will not refresh in Salesforce unless you delete the old ContentNote or load it by hand. After cutover, revoke any leftover session used to query notes.

### 3. Every refresh pauses recurring gift schedules

The mapping always sends `Type = PauseTransactions`. That is correct for the first load. After finance turns schedules on, the next sync used to pause them again.

**How it was fixed:** For GiftCommitmentSchedule rows whose Bloomerang external ID already exists in Salesforce, `Type` is omitted from the payload so Salesforce keeps the current value. New schedules still arrive paused.

**What we still need to do:** After the first load, activate schedules in Salesforce only once gift data has been checked. Confirm in a sandbox re-run that an activated schedule stays active.

### 4. Pledges are not migrated when you use the mapping file

Every `Pledges.csv` column is `SKIP` in the mapping, so mapping mode used to drop pledges entirely.

**How it was fixed:** Mapping mode now builds GiftCommitment rows from `Pledges.csv` in Python (donor, dates, recurrence type, description, campaign, name) and concatenates them with recurring commitments. Recurring IDs win if a transaction number collides.

**What we still need to do:** Confirm in sandbox that pledge GiftCommitment fields match Nonprofit Cloud (especially whether a total pledge amount belongs on the commitment or only on a schedule). Pledge installment schedules are still not created; if NPC needs a schedule per pledge, we must add that mapping after you confirm the API names.

### 5. Numeric IDs can become `12345.0`

Pandas used to infer all-digit ID columns as numbers.

**How it was fixed:** Every Bloomerang CSV is read as text. Identifier normalization also strips a trailing `.0` so older float-like values still match.

**What we still need to do:** Nothing further in code. If you ever re-run against data that was already loaded with `.0` keys, those old Salesforce rows will not match the new keys and would need a one-time cleanup.

### 6. A refresh treats Bloomerang as the winner for every mapped field

**How it was fixed:** Not changed in code. The script logs a warning on every run that a live re-run overwrites mapped Salesforce fields. There is no safe automatic merge of “staff edited this in Salesforce.”

**What we still need to do:** Write a one-page dual-run rule before occasional refresh runs. Either Bloomerang stays source of truth until cutover (staff do not edit mapped fields in Salesforce), or you list Salesforce-only fields and we remove those columns from the mapping so later upserts cannot touch them.

---

## High

### 7. Fund splits are not approved and need a custom field

**How it was fixed:** The script describes GiftTransactionDesignation before upsert. If `Bloomerang_TxnDesignation_Key__c` is missing, it skips that object and logs an error instead of failing opaquely. Split gifts on the parent GiftTransaction are also aggregated before join so the parent gift is not exploded.

**What we still need to do:** In Salesforce Setup, create `Bloomerang_TxnDesignation_Key__c` as a unique External ID text field on GiftTransactionDesignation, then set those mapping rows to Approved. Re-run so fund allocations load. Until that field exists, by-fund reports will not match Bloomerang.

### 8. Multi-fund gifts collapse on the transaction

**How it was fixed:** `Donations.csv` is aggregated to one row per TransactionNumber before it is joined onto Transactions. Note fields are concatenated; other donation-level fields keep the first non-blank value. Fund split amounts still belong on GiftTransactionDesignation.

**What we still need to do:** After the designation field exists, compare designation amount sums in `reconciliation.csv` to Bloomerang. Mail code / DVD / campaign on the gift header still come from one designation row (the first), so split gifts that used different campaigns per fund still need a business rule if that matters.

### 9. Campaign vs Appeal lookup is backwards from the notes

**How it was fixed:** For `CampaignId` only, the first non-null value wins. In `field_mapping.csv` CampaignName is listed before AppealName, so Campaign wins and Appeal is the fallback, matching the mapping notes.

**What we still need to do:** Spot-check gifts that have both a Campaign name and an Appeal name in Bloomerang and confirm they attached to the Campaign you expected.

### 10. Individual record type is unresolved

**How it was fixed:** The script no longer fails silently. If the org does not have a Record Type whose DeveloperName is `PersonAccount` (or Organization / Household), it logs an error listing what the org actually has. It does not guess Household for individuals.

**What we still need to do:** Open Account Record Types in Setup and decide whether individuals are Person Accounts or Households. If they are Households, change the mapping from `PersonAccount` to `Household` before the first live load. A sandbox load of a few individuals will show whether RecordTypeId populated.

### 11. Phone, email, and address keys are not normalized

**How it was fixed:** Composite external IDs now use the same cleaning as the visible fields: phones are digits only, emails are lowercased, street text has whitespace collapsed. Emails are lowercased in `clean_email` as well.

**What we still need to do:** If contact points were already loaded with the old raw keys, a refresh will insert duplicates rather than update. Either load into an empty sandbox, or delete the old ContactPoint rows before the next run.

### 12. There is no dollar or count tie-out

**How it was fixed:** Each dry-run and live run writes `reconciliation.csv` under `--output-dir`, including constituent counts, gift dollar sums from Transactions versus prepared GiftTransaction, pledge counts, and designation amounts. A warning is logged when those gift sums differ.

**What we still need to do:** Make reading that file part of the runbook. Do not treat a Salesforce load as successful until export gift dollars and prepared gift dollars match within a few cents, and pledge counts look right.

### 13. Household membership and relationships are skipped

**How it was fixed:** Not changed in code. The mapping still skips Head, Members, and all of Relationships.csv by request.

**What we still need to do:** If household giving views matter in Salesforce, decide the NPC membership object (for example AccountContactRelation) and add a mapping for Head/Members and Relationships. Until then, household Accounts can exist without their people linked.

### 14. `--since` is not a delta pipeline

**How it was fixed:** The script logs a warning on every run that `--since` only filters Notes and that everything else is a full snapshot upsert. Existing notes are skipped by Title regardless of `--since`.

**What we still need to do:** Train operators not to treat `--since` as an incremental migrate. Occasional refresh means a full Bloomerang export and a full upsert of mapped objects, with the overwrite rule from item 6.

### 15. Forgetting `--mapping-file` uses a thinner hardcoded path

**How it was fixed:** If `field_mapping.csv` sits next to `Upsert.py`, it is used automatically. If it is missing, the script warns that it is on the thinner hardcoded path.

**What we still need to do:** Keep `field_mapping.csv` beside the script. If you move the files, pass `--mapping-file` explicitly.

---

## Medium

### Addresses (Mailing vs Billing)

**How it was fixed:** ContactPointAddress AddressType now comes from one named dictionary (`CONTACT_POINT_ADDRESS_TYPE_BY_CONSTITUENT`: Individual → Billing, Org/Household → Shipping). Account custom line fields still use Mailing for individuals, which is what the mapping CSV specifies for those fields.

**What we still need to do:** Confirm with the Salesforce admin which Account line fields mailings actually use. If they want Billing lines on Person Accounts instead of Mailing lines, say so and we can point the Account split-street logic at Billing.

### Campaigns keyed by name

**How it was fixed:** Not changed in code. Lookups from gifts still resolve by Appeal/Campaign **name**, so the external ID has to stay the name.

**What we still need to do:** Do not rename appeals or campaigns in Bloomerang during the transition if you can help it. If Bloomerang later exports a stable numeric ID, we can switch the external ID to that ID and keep Name as a display field.

### Refunds

**How it was fixed:** Multiple refunds on the same transaction are summed. Notes from each refund are appended. Full versus partial refund now compares against `OriginalAmount` (the mapping field) as well as `Amount`.

**What we still need to do:** Spot-check a gift that was refunded more than once in Bloomerang and confirm RefundedAmount and the admin note look right in Salesforce.

### Dates

**How it was fixed:** Calendar dates sent as datetimes are formatted as noon UTC so a US timezone does not roll the gift to the previous evening. Timed values are converted to UTC.

**What we still need to do:** In sandbox, check a handful of gift dates against Bloomerang, including gifts entered late in the evening.

### WeGive_ID__c placeholder

**How it was fixed:** Not changed in code. The field is still required in this org and is still filled with the fund name.

**What we still need to do:** Ask whoever owns WeGive whether fund name is an acceptable ID. If not, leave the first load as-is only if they will overwrite WeGive_ID__c later, or we stop sending that field once they confirm it is not actually required.

### Treatement typo

**How it was fixed:** After mapping, `Treatement` on `Donor_Pathway_Segment__c` is rewritten to `Treatment`. Restricted picklist values that still do not match the org are cleared before upsert so the rest of the Account row can load.

**What we still need to do:** Confirm the Salesforce picklist label is `Treatment`. If the org kept the typo on purpose, tell us so we can stop rewriting it.

### Deceased is one-way

**How it was fixed:** `Deceased__c` is now True when Bloomerang Status is Deceased and False otherwise, so a later export can un-check someone who was marked deceased in error.

**What we still need to do:** Understand that a Salesforce-only deceased flag will be overwritten on the next refresh (same as item 6). If deceased must be editable only in Salesforce, remove `Deceased__c` from the job after the first load.

### Bad emails and addresses

**How it was fixed:** Rows with `IsBad` true (including 1/yes) are dropped from Emails, Addresses, and Phones before transform.

**What we still need to do:** Nothing further in code unless you also want bounced emails dropped using another Bloomerang column.

### Sample testing and soft credits

**How it was fixed:** `--sample-fraction` now keeps parent gifts (and their donors) that sampled soft credits point at, so a 5% sandbox test can resolve GiftSoftCredit the same way a full file would.

**What we still need to do:** When you rehearse, use `--sample-fraction 0.05` against sandbox and confirm a known soft credit appears.

### Note HTML and labels

**How it was fixed:** Note body lines are HTML-escaped. Custom amount and check number are labeled `Amount:` and `Check Number:`.

**What we still need to do:** Nothing further in code.

### Unknown picklist values

**How it was fixed:** Before each upsert, restricted picklists are described from the org. Values that are not in the active picklist are cleared (multi-select drops only the bad parts) and logged, so the rest of the row can load.

**What we still need to do:** Read those warnings. A cleared prefix or payment method means Salesforce got the record without that field. Add the missing picklist value in Setup if you need it, then re-run.

### Credentials in `.env`

**How it was fixed:** Credential values are still not logged. The script warns when it loads `.env` and tells you to keep it off shared drives and revoke the session after the run. Production is blocked without `--production`.

**What we still need to do:** Store `.env` only on the operator’s machine. After each live run, log out of Workbench or revoke the session. Do not email the file or put it in the shared nonprofit drive.

---

## Low

### Default input folder is a dated export directory

**How it was fixed:** If that folder is missing, the script errors and asks for `--input-dir` instead of failing later on missing CSVs. Default output is now `migration-output` rather than another dated sample folder.

**What we still need to do:** Always pass `--input-dir` pointing at the **current** Bloomerang export. Do not rely on the dated default once a newer export exists.

### Quarterly recurring maps to Monthly with interval 3

**How it was fixed:** Not changed in code. That is a mapping choice for ten records.

**What we still need to do:** In sandbox, open one quarterly schedule and confirm Nonprofit Cloud bills every three months. If the org has a real Quarterly period, change those two mapping rows in `field_mapping.csv`.

### Interactions are skipped by request

**How it was fixed:** Not changed in code.

**What we still need to do:** If cultivation history must live in Salesforce, add an Interaction (or Task) mapping later. Until then, those rows stay in Bloomerang only.

---

## Recommended order before a live load

1. Confirm sandbox vs production: omit `--production` and use `SF_DOMAIN=test`.
2. Keep `field_mapping.csv` next to `Upsert.py` (it is picked up automatically).
3. Pass `--input-dir` at the current export folder.
4. Dry-run, then open `reconciliation.csv` and tie out gift dollars and pledge counts.
5. Confirm Person Account vs Household in Setup.
6. Create `Bloomerang_TxnDesignation_Key__c` if fund splits are required.
7. Load a 5% sample into sandbox (`--sample-fraction 0.05`), then a full sandbox load.
8. Confirm notes did not duplicate on a second sandbox run, and that an activated recurring schedule stayed active.
9. Write the dual-run field-ownership rule before any production refresh.
10. Production load with `--production` only after sandbox sign-off.

---

## Finding summary

| ID | Priority | Finding | How it was fixed | What we still need to do |
| --- | --- | --- | --- | --- |
| C1 | Critical | Default Salesforce login is production | Live runs default to sandbox. Production username login or a production instance URL is refused unless you pass `--production`. | Use sandbox credentials without `--production` for rehearsal. Pass `--production` only when you intend to write to the live org, after checking the username or instance URL. |
| C2 | Critical | Notes are inserted, never upserted | Existing ContentNote titles are queried and skipped. If that query fails, notes are not inserted at all. | Notes that change in Bloomerang after the first load still will not update in Salesforce. Delete or replace those ContentNotes by hand if a later version must replace the first copy. |
| C3 | Critical | Schedules are forced back to PauseTransactions on every upsert | For schedules that already exist in Salesforce, Type is omitted so the current value is kept. New schedules still arrive paused. | Activate schedules in Salesforce only after gift data is verified. Re-run in sandbox and confirm an activated schedule does not go back to paused. |
| C4 | Critical | Pledges are not migrated when the mapping file is used | Mapping mode now builds GiftCommitment rows from Pledges.csv in Python and merges them with recurring commitments. | Confirm pledge fields against Nonprofit Cloud in sandbox. Pledge installment schedules are still not created; add that mapping if NPC requires a schedule per pledge. |
| C5 | Critical | Numeric IDs can become 12345.0 when CSVs are read | All export CSVs are read as text. Identifier cleanup also strips a trailing `.0`. | If Salesforce already contains `.0` keys from an earlier test load, those rows will not match. Use a clean sandbox or clean up those keys once. |
| C6 | Critical | Full upsert overwrites Salesforce edits during the dual-run period | Not changed in code. Every run logs that a live refresh overwrites mapped fields. | Write a dual-run rule: either Bloomerang remains source of truth until cutover, or list Salesforce-only fields and remove them from the mapping so later upserts cannot touch them. |
| H1 | High | Fund splits are not approved and need a custom external ID | GiftTransactionDesignation is skipped with a clear error if `Bloomerang_TxnDesignation_Key__c` is not in the org. | Create that unique External ID text field in Setup, approve the mapping rows, and re-run so fund allocations load. Until then, by-fund reports will not match Bloomerang. |
| H2 | High | Multi-fund gifts collapse to one GiftTransaction | Donations are aggregated to one row per transaction before join. Notes are concatenated; other fields keep the first non-blank value. | After designations load, compare designation amount sums in reconciliation.csv to Bloomerang. Decide what to do when one gift used different campaigns per fund. |
| H3 | High | Campaign vs Appeal lookup order is the reverse of the notes | CampaignId now keeps the first non-null value, so CampaignName wins and AppealName is the fallback. | Spot-check gifts that have both a campaign and an appeal in Bloomerang and confirm they attached to the campaign you expected. |
| H4 | High | Individuals map to PersonAccount; reviewer notes say only Household and Organization | Missing Record Type developer names are logged as errors with the list of types the org actually has. The script does not guess Household. | Open Account Record Types in Setup and decide Person Account vs Household for individuals. Change the mapping before the first live load if PersonAccount is not in the org. |
| H5 | High | Phone, email, and address external IDs are not normalized | Composite keys now use digits-only phones, lowercased emails, and collapsed street text, matching the visible fields. | If contact points were already loaded with the old raw keys, delete them or use a clean sandbox so the next run does not create duplicates. |
| H6 | High | There is no gift-total or record-count reconciliation | Dry-run and live runs write reconciliation.csv with counts and gift dollar sums, and warn when export vs prepared gift totals differ. | Make that file part of the runbook. Do not sign off a load until gift dollars and pledge counts tie out. |
| H7 | High | Household members and relationships are skipped | Not changed in code. Those mapping rows remain skipped by request. | If household giving views matter, choose the NPC membership object and add mappings for Head, Members, and Relationships.csv. |
| H8 | High | `--since` only filters Notes; everything else is a full reload | Every run logs that `--since` is notes-only and that other objects are a full snapshot upsert. | Do not treat `--since` as an incremental migrate. Occasional refresh means a full export and a full upsert, subject to the overwrite rule in C6. |
| H9 | High | Omitting `--mapping-file` uses a thinner hardcoded path | field_mapping.csv next to the script is used automatically. A warning is logged if it is missing. | Keep field_mapping.csv beside Upsert.py, or pass `--mapping-file` whenever the files are not in the same folder. |
| M1 | Medium | Individuals get Mailing lines on Account and Billing on ContactPointAddress | ContactPoint AddressType now comes from a named dictionary (Individual → Billing). Account custom lines still use Mailing for individuals, as the mapping CSV specifies. | Ask the Salesforce admin which Account line fields mailings use. If they need Billing lines on Person Accounts, we can switch the Account split-street category. |
| M2 | Medium | Campaigns are keyed by name, and Appeals and Campaigns.csv are two upserts | Not changed in code. Gift lookups still resolve by name, so the external ID must stay the name. | Avoid renaming appeals or campaigns in Bloomerang during transition. If a stable Bloomerang ID appears in a later export, we can switch the external ID to that ID. |
| M3 | Medium | Only the first refund per transaction is kept | Refunds are grouped by original transaction. Amounts are summed and notes are appended. Full vs partial uses OriginalAmount. | Spot-check a gift that was refunded more than once in Bloomerang. |
| M4 | Medium | Datetime fields append Z without converting to UTC | Date-only values are sent as noon UTC to avoid a timezone day-shift. Timed values are converted to UTC. | In sandbox, compare a handful of gift dates to Bloomerang, including gifts entered late in the day. |
| M5 | Medium | WeGive_ID__c is filled with the fund name as a placeholder | Not changed in code. The field is still sent as the fund name because it was marked required. | Ask the WeGive owner whether fund name is an acceptable ID. If not, either overwrite those values later or stop sending the field once they confirm it is not required. |
| M6 | Medium | Donor pathway maps Treatement (typo) through unchanged | Treatement is rewritten to Treatment on Donor_Pathway_Segment__c. Invalid restricted picklist values are cleared before upsert. | Confirm the Salesforce picklist value is Treatment. If the org kept the typo, tell us so we can stop rewriting it. |
| M7 | Medium | Deceased is one-way; Active/Inactive omit the field | Deceased__c is True for Bloomerang Status=Deceased and False otherwise, so a later export can un-check a mistaken deceased flag. | A Salesforce-only deceased flag will be overwritten on refresh. Remove Deceased__c from the job after first load if Salesforce must own that field. |
| M8 | Medium | IsBad emails and addresses are still loaded | Emails, Addresses, and Phones marked IsBad are dropped before transform. | Nothing further unless you also want another Bloomerang bounce column used as a filter. |
| M9 | Medium | In-process sampling does not pull parent gifts for soft credits | Sample mode now keeps parent gifts and donors referenced by sampled soft credits. | Rehearse with `--sample-fraction 0.05` and confirm a known soft credit appears in sandbox. |
| M10 | Medium | Note HTML is unescaped; amount and check number have no labels | Note lines are HTML-escaped. Amount and check number are labeled in the note body. | Nothing further in code. |
| M11 | Medium | Unknown picklist values pass through | Restricted picklists are described from the org. Unknown values are cleared and logged so the rest of the row can load. | Read those warnings. Add missing picklist values in Setup if you need the data, then re-run. |
| M12 | Medium | Session IDs and passwords live in a local .env beside the script | Values are still not logged. Loading .env now warns you to keep the file private and revoke the session. Production is blocked without `--production`. | Keep .env on the operator’s machine only. After each live run, revoke the Salesforce session. Do not copy the file to a shared drive or email. |
| L1 | Low | Default input folder is a dated export directory | A missing default folder now errors and tells you to pass `--input-dir`. Default output is migration-output, not another dated sample folder. | Always pass `--input-dir` at the current Bloomerang export. Do not rely on the dated default once a newer export exists. |
| L2 | Low | Quarterly recurring maps to Monthly with interval 3 | Not changed in code. That mapping still covers the ten quarterly records. | Open one quarterly schedule in sandbox. If NPC has a real Quarterly period, change those two rows in field_mapping.csv. |
| L3 | Low | Interactions are skipped by request | Not changed in code. | Add an Interaction or Task mapping later if cultivation history must live in Salesforce. Until then those rows stay in Bloomerang only. |

---

*Person Account vs Household and the designation external ID still need a look in Salesforce Setup before a sandbox load. Run dry-run with `--mapping-file` (or the default beside the script) and read `reconciliation.csv` before any live upsert.*
