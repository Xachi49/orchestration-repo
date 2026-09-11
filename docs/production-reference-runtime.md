# Production reference runtime

## What it is

One canonical assembly of the governed orchestrator for production-like
operation: Fastify API, PostgreSQL authoritative persistence, workers,
recovery coordinators, and all Phase 2–24 services composed through
`createPostgresOrchestratorStack` / `createReferenceRuntimeQualification`.

## What it is not

- Not a second authority system
- Not a deployer
- Not an in-memory production fallback
- Not a fault-injection host

## Operating modes

| Mode | Persistence | Fault injection | Authority seeding on boot |
| --- | --- | --- | --- |
| DEVELOPMENT | may be non-Postgres for local | denied in PRODUCTION paths | explicit only |
| TEST | PostgreSQL for qualification | allowed only in TEST/STAGING seams | explicit bootstrap/test helpers |
| STAGING | PostgreSQL | denied for production synthesis | explicit only |
| PRODUCTION | PostgreSQL required | impossible | zero auto-mint |

## Startup order

1. parse/validate configuration  
2. establish DB connectivity  
3. check supported schema  
4. verify migration state  
5. initialize durable repositories  
6. resolve production runtime manifest  
7. reconcile durable recovery state  
8. initialize canonical services  
9. initialize workers  
10. initialize API  
11. perform readiness checks  
12. transition to READY  
13. accept traffic  

## Liveness vs readiness

- **Liveness**: process event loop alive  
- **Readiness**: safe to receive intended traffic (DB, schema, config, recovery)

Phase23 certification is a **release qualification input**, not a business-action gate.
