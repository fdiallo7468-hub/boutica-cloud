# Phase 4.3 — operational accounting integration contract

## Current state

The only automated operational posting implemented in the current branch is EXPENSE, through one explicitly configured debit/credit account pair. Migration 0018_accounting_operational_mappings.sql restricts source_type to EXPENSE. This is not a completed Phase 4.3.

The existing ledger engine already supports balanced entries with 2–200 lines, source references, idempotency, tenant-owned accounts, open-period checks and immutable posted entries. The missing layer is an event-to-multi-line mapping model and safe integration inside each originating business transaction.

## Required architecture

1. Replace the single debit/credit pair mapping with a tenant-owned posting template:
   - event type and optional category/payment-method selector;
   - journal;
   - ordered posting lines;
   - account per line;
   - debit/credit side;
   - explicit amount basis;
   - optional customer/supplier auxiliary dimension.
2. Compute line amounts from persisted transaction rows only. Never trust client-supplied totals, prices, cost, or account identifiers.
3. Require all template lines to resolve to positive exact-decimal amounts and validate total debit = total credit before posting.
4. Reuse the ledger engine's source idempotency (sourceType, sourceId) so retries cannot duplicate entries.
5. Execute the posting in the same PostgreSQL transaction as the source business operation. A failed posting must roll back the originating operation when the tenant has configured mandatory automatic posting. An unmapped event must return an explicit NOT_CONFIGURED result and must never fabricate accounts.
6. Resolve the accounting period from the event's business date and require it to be OPEN. Preserve the event's location and tenant scope.
7. Corrections must reverse the original posted entry; never mutate a posted entry or silently create a second, unrelated posting.

## Event coverage and prerequisites

| Event | Source data available | Required accounting treatment | Current blocker |
|---|---|---|---|
| Sale completed | Sale subtotal, discount, net total, item quantities, sale-time cost snapshots, customer, location | Receivable/revenue/discount plus cost-of-sales/inventory lines | Needs multi-line templates; tax treatment is not modelled |
| Purchase received | Purchase total, item quantities/prices, optional supplier, location | Inventory/expense and supplier or clearing counterpart | Supplier is optional; tax/freight/discount treatment is not modelled |
| Payment confirmed | Amount, payment method, customer, optional sale/receivable | Treasury account against receivable, advance, or other applicable account | Mapping must vary by payment method and linkage; exact cash/bank account is business-configured |
| Payment cancelled | Original payment and cancellation record | Reverse the original payment entry exactly once | Must link to the original accounting entry and use the ledger reversal mechanism |
| Receivable created | Sale/customer/initial amount/paid amount | Must not duplicate the sale entry; only post a distinct reclassification if the accounting policy requires it | Policy and event timing must be specified |
| Return completed | Return total, sale items, returned quantity, RESTOCK/DAMAGED condition, original cost snapshots | Sales return/credit note plus inventory/COGS reversal where physically restocked | Current workflow does not issue refunds or adjust receivables/payments; damaged goods require a separate treatment |
| Sale cancelled | Original sale, items, restored stock; cancellation is blocked after completed returns or confirmed payments | Reverse the original sale and cost-of-sales entries | Must identify and reverse original source entries atomically |
| Stock adjusted | Quantity delta, variant and location | Inventory against an adjustment/variance account | Valuation method (e.g. FIFO or weighted average) is not defined; current stock quantity is not a reliable accounting valuation |
| Expense created | Category, amount, description, location | Expense and treasury/payable accounts | Implemented only for explicitly configured categories |

## Rules that must not be guessed

- Do not hard-code SYSCOHADA account numbers or create default account mappings.
- Do not infer a cash/bank account from a payment-method label.
- Do not assume that every purchase is paid immediately or that every sale is cash-settled.
- Do not post tax lines until tax fields and tax-inclusive/exclusive semantics exist in the source domain.
- Do not value inventory adjustments from current purchase price until the product's costing method is explicitly chosen and historical cost layers are available.
- Do not post a return as a cash refund: the current return workflow has no refund/payment reversal operation.
- SYSCOHADA legal conformity and the account templates must be reviewed by a qualified Mali/OHADA accounting professional.

## Acceptance tests

- Every supported event produces a balanced entry from persisted source data and explicit tenant configuration.
- Missing mappings never produce guessed entries.
- A retry of the same source event produces one entry only.
- A failed posting rolls back the source operation when automatic posting is configured as mandatory.
- Closed periods, inactive journals/accounts, cross-tenant mappings and invalid auxiliaries are rejected.
- Payment cancellation and sale cancellation reverse the exact original entries once.
- Return tests cover RESTOCK and DAMAGED separately.
- PostgreSQL E2E tests cover concurrency, transaction rollback, idempotency and tenant isolation.
- Trial balance, customer/supplier auxiliary ledgers and stock valuation reconcile with source events.

**Release status:** Phase 4.3 remains open until all in-scope event families are implemented or explicitly removed from the approved scope. A green CI run does not close this accounting acceptance gate.
