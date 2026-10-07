# Commerce shutdown

Deposits, purchases (JWT/API token), bandwidth top-ups, manual/admin renewals and automatic renewal scans are disabled.

To resume, set COMMERCE_DISABLED to false in BOTH files:
- proxy_server/src/common/commerce-policy.ts
- proxy/src/lib/commerce-policy.ts

Rebuild and restart frontend, backend and workers after changing these source flags.

Existing proxy use, order reads and refunds remain available. Admin deposits, transaction approvals and order creation are blocked too.

Caveats:
- Already-running requests and previously queued purchases are not cancelled.
- Bank transfers cannot be prevented by website changes. Disable incoming payments with the bank/payment provider separately if needed.
- Blocked deposit webhooks return HTTP 403 without creating transactions. Providers may retry. Reconcile bank transfers and webhook retries before reopening.
- Auto-renew schedules are retained and may resume after reopening.

Verification: frontend/backend TypeScript checks and 12 commerce-policy unit tests passed.
