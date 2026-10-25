# Voucher backend contract

## HTTP API (frontend integration contract)

All routes require authentication; `/api/admin/vouchers/*` and the products picker require admin role.

- `GET /api/admin/vouchers?search,status,page,limit` → `{data,total,page,limit}`.
- `POST /api/admin/vouchers`, `PUT /api/admin/vouchers/:id` → voucher.
- No hard delete: set `status: 'archived'`.
- `GET /api/admin/vouchers/stats` → cached aggregate usage statistics.
- `GET /api/admin/vouchers/usages?code,userId,serviceId,status,from,to,page,limit` → `{data,total,page,limit}`.
- `GET /api/admin/vouchers/audit?voucherId,page,limit` → `{data,total,page,limit}`.
- `GET /api/admin/vouchers/export` with usage filters → CSV.
- `GET /api/vouchers/products?search` → `[{_id,name}]` (admin product picker).
- `POST /api/admin/vouchers/orders/:id/confirm-failure` with `{evidence:string}` (10–2000 characters): operator assertion that the provider confirmed no fulfilment; only unresolved PENDING_REFUND orders qualify. Then use the existing approve-refund/refund route. Confirmation is an irreversible resolution fence and records actor/evidence in usage events.
- `POST /api/orders/quote`: authenticated; accepts `BuyOrderDto` plus optional `voucher_code`; returns `{subtotal,voucher_discount,total_price,voucher:{code,name,...}|null,quantity,price_per_unit}`. Quote is advisory, reserves nothing.
- Existing buy routes accept `voucher_code`; voucher purchases require `Idempotency-Key`. Reusing a key with a different payload is HTTP 409. Existing order data includes `subtotal` and immutable `voucher_snapshot`.

Write shape: `{code,name,status,startsAt,endsAt,discountType:'percentage'|'fixed',discountValue,maxDiscount,minSubtotal,scope:'all'|'selected',serviceIds:string[],totalLimit,perUserLimit}`.
Status: `draft|active|paused|archived`. Dates are ISO timestamps, start inclusive/end exclusive. Money is safe integer currency units; minimum subtotal may be zero. Percentage is positive, at most 100, at most two decimal places. `maxDiscount` defaults to a safe-integer cap. Limits are positive integers. Responses contain `_id`, all write fields, and `reserved`/`used` counts.

One voucher applies only to new purchases, after user-specific service pricing. The ordinary money wallet (including credited deposit bonuses) pays the net amount. Renewals and bandwidth top-ups do not apply vouchers. Percentage discounts round down; discounts cannot exceed subtotal or maxDiscount.

## Durability and operations

MongoDB standalone remains unchanged; no transactions or replica set required. Voucher capacity is authoritative in one voucher document, including total/per-user reservations and lifecycle events. Purchase intents uniquely identify `(user,idempotency key)`, fingerprint the payload, preallocate the order ID, and retain its complete priced snapshot before debit. Conditional wallet updates store debit/refund receipts in the same User document as money. Redis is only an advisory configuration cache (120 seconds), rate limiter, statistics cache, and dispatch transport. Database reconciliation recovers interruptions before order insertion and lost queue messages.

Provider calls cannot be made exactly-once against providers without idempotency support. Voucher dispatch therefore claims a durable one-way MongoDB fence before calling a provider, makes only one buy attempt, and never automatically clears that fence. An interrupted/ambiguous provider call retains the reservation and debit for operator reconciliation; do not blindly retry. ACTIVE/PARTIAL consumes usage; confirmed failed full refunds release usage. Poll timeouts alone are not confirmed provider failure. Partial refunds allocate the net order price using integer arithmetic, never the undiscounted per-unit price.

Embedded receipts/reservations/audit history are deliberately bounded and never silently pruned: admission fails closed before the configured cap. MongoDB's 16 MiB document limit still applies; monitor document sizes. A high-volume installation must migrate to an equivalent durable ledger boundary before increasing caps or removing old entries. Archived codes remain unique and receipts must survive backup/restore together with wallets, vouchers, intents and orders.

`COMMERCE_DISABLED` remains true. Quote/admin configuration does not enable commerce.

### Bounds and recovery policy

- Per voucher: at most 10,000 admission records (including rejected/released tombstones), 1,000 admin audit records, and an 8 MB admission/write threshold. Per user: at most 10,000 voucher wallet receipts and an 8 MB admission threshold, leaving BSON headroom. These are lifetime limits, not rolling windows. No TTL or pruning removes authoritative records. Existing deposit receipts remain separate and unchanged.
- Reconciler: every 30 seconds, 100 intents ordered by least-recently reconciled timestamp. Each intent is its durable dispatch outbox; PENDING/unclaimed orders are requeued until claimed, PROCESSING outcomes are repolled, saved provider responses/proxy batches are recovered. Fenced dispatch with no saved result becomes PENDING_REFUND after ten minutes; money and capacity remain retained until explicit provider reconciliation.
- One immutable refund plan per voucher order. Partial fulfilment uses the existing refund-missing route and refunds `floor(netPaid * missing / ordered)`, preserving the voucher use. Full failed refunds require explicit confirmation; partial manual refunds of a confirmed failed order are supported, but a different subsequent refund plan is rejected. A later second refund requires a deliberate ledger migration/extension, not a changed amount on retry. The plan, actor, wallet receipt, usage event and wallet-history projection are durable and reconciled.
- `price_per_unit` remains the user-specific unit price before the order-level voucher. Use `subtotal`, `voucher_snapshot.discount`, and `total_price` for net totals; never calculate a voucher refund using `price_per_unit`.
- Quotes can reflect configuration for up to 120 seconds, especially after cache invalidation failure. Every purchase revalidates directly against MongoDB, including revision, time, status, scope and both quotas. Redis quote limit is 30/user/minute; Redis failure falls back to 5/user/minute in MongoDB. Stats TTL is 60 seconds. CSV is bounded to 10,000 matching usages; narrow filters for larger histories.

### Review hardening: dispatch, expiry, affiliate and evidence

- Manual `sync-provider-order` takes the same permanent dispatch fence as worker buy before fetching. A worker-owned PENDING dispatch is rejected as in-flight; PENDING_REFUND also requires the owning worker's durable `voucher_buy_finished` signal (a timeout alone does not prove the call ended). A reconciliation-owned fence survives empty/failed fetches and records the provider order ID for polling recovery. Worker claims also require `voucher_resolution: 'open'`. An interrupted worker without a saved provider result/finished signal requires explicit provider-failure resolution rather than blind manual fulfilment.
- Expiration excludes unresolved voucher orders and voucher orders with pending affiliate work. Voucher usage consumption requires durable `fulfilled` resolution plus positive delivered quantity; EXPIRED alone is never proof. Reconciliation moves legacy unfulfilled/open EXPIRED orders to PENDING_REFUND for provider reconciliation, retaining money and quota.
- Full ACTIVE fulfilment atomically records `voucher_affiliate_pending` with its status. The reconciler retries the existing affiliate commission hook in error-propagating mode and clears the flag only after success. The unique commission `order_id` index prevents duplicate commissions across concurrent/replayed hooks; creation does not credit an affiliate wallet. Late recovery of an already expired fulfilled order also confirms its commission.
- Failure confirmation atomically stores `voucher_failure_confirmation: {actor,evidence,at}` with the irreversible failed resolution. The usage `failureConfirmation` projection and its single audit event are repaired by reconciliation or an identical confirmation retry. Changed actor/evidence cannot overwrite the original confirmation.

### Verification

`npm run build`

Unit/targeted regression suites: `npm test -- --runInBand --testPathPatterns="vouchers|orders-bandwidth|commerce-policy|deposit-promotions"`

Standalone integration is explicit opt-in: set `VOUCHER_TEST_MONGO_URI=mongodb://127.0.0.1:27017` and run the above command. Tests create a unique `voucher_test_<ObjectId>` database and drop only that database afterward. They never use the application's configured database. Set `DEPOSIT_TEST_MONGO_URI` separately to include the existing deposit integration regression suite.
