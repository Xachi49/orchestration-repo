# Program delegation model

## Equation

```text
ChildAuthority ⊆ ProgramDelegationEnvelope ⊆ ParentAuthorizedAuthority
```

Never union. Intersection only for:

- projects
- environments
- repositories
- capabilities
- budget ceilings

## Envelope fields

See `DelegationEnvelope` in `src/programs/delegation-envelope.ts`.

Cross-project children require:

1. `crossProjectDelegationAllowed === true`
2. child project listed in `allowedProjectIds`
3. materialization approver authorized for required scope

Default Phase 14: fail closed (`crossProjectDelegationAllowed: false`).

## Policy inheritance

Children may add stricter constraints. They may not drop parent deny constraints
such as `no production deployment`. The validator emits `POLICY_WEAKENING_REJECTED`.
