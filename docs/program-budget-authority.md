# Program budget authority

Parent program budget is escrowed in `program_budget_ledgers`.

Before each child materialization, a reservation is CAS-updated onto the ledger.
Concurrent materializers cannot over-allocate.

```text
available = ceiling − (active_reserved + settled)
```

## Release categories

| Category | Meaning |
|---|---|
| `RELEASEABLE_PLANNING` | Reservation never produced external effect; may be released explicitly |
| `NON_RELEASEABLE_EXTERNAL` | Ambiguous or executed spend; do not auto-recycle |

Budgets partition across children. Sum(child) ≤ program ceiling. Model requests
that multiply budget are rejected (`PROGRAM_BUDGET_MULTIPLICATION`).
