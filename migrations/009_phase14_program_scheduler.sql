-- Phase 14: program scheduler work kinds + materializer authority role.

-- Expand scheduler work_kind check for Program progression (Phase 13 claim/fence).
ALTER TABLE scheduler_work_items DROP CONSTRAINT IF EXISTS scheduler_work_items_work_kind_check;
ALTER TABLE scheduler_work_items ADD CONSTRAINT scheduler_work_items_work_kind_check
  CHECK (work_kind IN (
    'INGEST_REPOSITORY',
    'PLAN_RUN',
    'VALIDATE_PLAN',
    'ROUTE_AUTHORIZATION',
    'EXECUTE_PLAN',
    'VERIFY_OUTCOME',
    'LEARN_FROM_RUN',
    'BUILD_OBSERVABILITY',
    'DECOMPOSE_PROGRAM',
    'VALIDATE_PROGRAM',
    'ROUTE_PROGRAM_MATERIALIZATION',
    'MATERIALIZE_PROGRAM',
    'RECONCILE_PROGRAM',
    'VERIFY_PROGRAM'
  ));

-- Program materialization role is distinct from Phase 6 execution approver.
ALTER TABLE authority_grants DROP CONSTRAINT IF EXISTS authority_grants_principal_type_check;
ALTER TABLE authority_grants ADD CONSTRAINT authority_grants_principal_type_check
  CHECK (principal_type IN ('REQUESTER', 'APPROVER', 'PROGRAM_MATERIALIZER'));
