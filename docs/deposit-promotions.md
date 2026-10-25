# Deposit promotions backend contract

All routes require the existing Bearer JWT. `/api/admin/*` also requires the existing admin role. New endpoints return **raw JSON**, with no `data` or `success` wrapper. Dates serialize as ISO-8601 strings; IDs are strings. Normal Nest error responses/statuses apply (400 validation/mismatch, 401 authentication, 403 authorization/commerce shutdown, 404 missing program, 409 overlap/concurrent edit/intent reuse).

## Program administration

- `GET /api/admin/deposit-promotions` → `Program[]` (an array, including when empty).
- `POST /api/admin/deposit-promotions` → created `Program` (201).
- `PUT /api/admin/deposit-promotions/:id` → replaced `Program` (200). All fields required.
- `DELETE /api/admin/deposit-promotions/:id` → `{id,deleted:true}` (200). Existing intents retain their snapshots.
- `GET /api/admin/deposit-promotions/stats` → `{receipts,depositAmount,bonusAmount,totalAmount}` (200). All-time completed receipts with a promotion snapshot; receipts below the first tier can count with zero bonus. Pending/crediting receipts are excluded until recovery completes.

Write body:

```json
{
  "name": "Deposit reward",
  "start": "2026-11-01T00:00:00+07:00",
  "end": "2026-12-01T00:00:00+07:00",
  "status": "draft",
  "tiers": [{"minAmount": 100000, "rate": 10}],
  "maxBonus": 50000
}
```

`Program` contains these fields plus `_id`. Status is `draft|active|paused`. Intervals are `[start,end)`. Active intervals cannot overlap, including under concurrent writes (catalog revision compare-and-swap). Adjacent intervals are permitted. Max 100 tiers; distinct nonnegative safe integer minimum amounts. Rates are percentages from 0 to 100 with at most two decimal places. `maxBonus` is a nonnegative safe integer VND per bank receipt; zero means zero bonus.

## Quote and intent

- `GET /api/deposit-promotions/quote?amount=100000` → `Quote` (200).
- `POST /api/deposit-promotions/intents` body `{"amount":100000}` → `Quote & {id,code,expiresAt}` (201).

```json
{
  "promotionId": "0123456789abcdef01234567",
  "promotionName": "Deposit reward",
  "rate": 10,
  "bonusAmount": 10000,
  "totalAmount": 110000,
  "amount": 100000
}
```

Without an active promotion: `promotionId` and `promotionName` are null, `rate`/`bonusAmount` are zero. Below the first tier of an active program, program identity is retained with zero rate/bonus. Amount is safe integer VND, minimum 10,000, and amount plus bonus must remain safe. The highest applicable minimum selects the tier; bonus is `min(floor(amount * rate / 100), maxBonus)`, computed with integer arithmetic.

An intent's code is `DPI` plus 24 random uppercase hexadecimal characters, protected by a unique index. Use it as the bank transfer description. It snapshots the entire program and quote, and expires 15 minutes after issue. The **actual bank transfer date**, not webhook arrival or approval time, must be within `[floorToSecond(issuedAt),expiresAt]`. Bank providers report timestamps at whole-second precision, so issuance is floored to the start of its second for eligibility only; stored issuance and the 15-minute expiry keep their exact milliseconds. This tolerates less than one second before the stored issuance, but never extends expiry. Editing, pausing, or deleting the program does not change issued terms. A transfer outside that interval receives principal only. A wrong user/amount or unknown intent code is rejected rather than silently receiving a different bonus. A valid intent can be consumed by only one transfer. Legacy `topup_code` and email matching remain ordinary nonbonus deposits. Manual balance adjustments do not opt into promotions.

## Crediting and recovery

Bank automatic credit and `POST /api/admin/transactions/:id/approve` use the same durable credit method. Approval retains the existing `{message,data}` wrapper and adds `data.promotion_snapshot` (`Quote`). It uses the matched user or an explicitly supplied email; it does not default unmatched deposits to the approving admin.

1. Reserve intent for the transaction and persist an immutable `credit_plan`; transaction becomes `crediting`.
2. A single conditional User update increments money and appends `deposit_credit_receipts` with the key, quote, timestamp, and exact before/after balances. Concurrent attempts cannot increment the same receipt twice.
3. Upsert separate `deposit` and positive `promotion_bonus` wallet entries using unique `credit_key` values.
4. Finalize transaction as `processed`, with `promotion_snapshot`, `credited_at`, and balances.

No replica set or Mongo transaction is required. Bank batches process all items and persist a webhook log including per-item failures. Permanent HTTP 400/409 business failures are recorded and acknowledged with HTTP 200 so a poison transfer does not prevent later valid transfers. Recoverable server/database failures produce HTTP 503 only after the entire batch has been processed and logged (`response.success=false`, log `status_code=503`); a log persistence failure itself also propagates for retry. Retrying the provider webhook or admin approval resumes existing `crediting` transactions and repairs ledger/finalization without another balance increment. No background reconciliation job is added; interrupted operations require a retry. Rejection cannot race a reserved credit. Historical `processed` records without a plan are treated as already credited and are not credited again; historical ambiguity is not automatically repaired. Existing Binance automatic processing is unchanged and does not award promotion bonuses.

## Existing feature gates and operational limitations

`COMMERCE_DISABLED = true` is preserved. It currently returns **403** before intent issuance, bank webhook processing, admin approval, or shared crediting. Admin program management, statistics, and authenticated read-only quotes remain available. This is the deliberate rollout blocker; this change does not enable commerce globally. When commerce is separately enabled, `DEPOSIT_ENABLED=false` still holds new automatic bank receipts for admin review.

Required new unique indexes are defined in Mongoose for intent `code` and wallet `credit_key` (partial string index); ensure they are built before rollout if deployment disables automatic index creation. Existing global numeric `transaction_id` uniqueness remains unchanged; provider ID namespaces must not collide. Bank timestamps without an explicit timezone retain existing JavaScript date parsing behavior; providers should supply unambiguous timestamps.

User receipts are intentionally retained and excluded from default selects. They must not be pruned without preserving idempotency in a migration. High-volume accounts eventually need an archival design before the MongoDB document size limit. The singleton catalog likewise targets a modest program inventory. Stats reflect only fully finalized records. No attempt is made to reconcile ambiguous historical credits.

### History, recovery filters, and socket integration

User transaction history, admin transaction history, and admin dashboard recent deposits include `promotion_snapshot`, `credited_at`, `balance_before`, and `balance_after`. Admin per-user finance deposit history already returns these fields without a restrictive projection. Existing history response wrappers are unchanged. `promotion_snapshot` is the Quote above, or null for historical entries.

`GET /api/admin/transactions?status=crediting` and `GET /api/transactions?status=crediting` accept the exact status for recovery (the user route remains scoped to the authenticated user). Admin transaction stats include `crediting`; list summaries include `total_crediting`. Admin approval can resume these receipts; rejection cannot cancel them.

Bank webhook/admin approval `topup_success` emits `{amount,balance,bonusAmount?,totalAmount?,promotionName?}`. `amount` is principal, `balance` is the saved post-credit balance, and optional promotion fields come from the credited snapshot (`promotionName` can be null). The frontend `src/hooks/use-socket.ts` consumes camelCase `bonusAmount` directly. Existing Binance payloads remain compatible with just amount/balance.

Bank credit notifications use an atomic `topup_success_claimed_at` marker after financial finalization, suppressing repeated emits across concurrent approvals and processed retries. This is **at-most-once attempted delivery**, not guaranteed delivery: a crash or socket failure after claiming can lose the notification. Financial history remains authoritative and credit recovery does not depend on notification delivery.

## Verification

```powershell
npm run build
$env:DEPOSIT_TEST_MONGO_URI='mongodb://127.0.0.1:27017'
npm test -- --runInBand --runTestsByPath src/deposit-promotions/deposit-promotions.spec.ts src/deposit-promotions/deposit-credit.integration.spec.ts src/common/commerce-policy.spec.ts
```

The integration suite uses a uniquely named disposable database and drops it afterwards, never the application's configured database. It mocks commerce shutdown only within the test process. Without `DEPOSIT_TEST_MONGO_URI`, the Mongo integration suite is skipped.
