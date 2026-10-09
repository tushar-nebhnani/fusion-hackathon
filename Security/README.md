# Security Engineering — Climate-Adjusted Financial Risk Score

This directory contains the security plan, threat model, implementation notes, and security tests for the hackathon project.

## Goals

Protect the confidentiality, integrity, and availability of:
- Business identity and location data
- Financial indicators and daily sales
- Climate observations and exposure data
- Risk scores, explanations, and lending/early-intervention recommendations
- User accounts, audit events, and notification channels
- API credentials, database credentials, and model artifacts

Security work must integrate with the main application. Controls such as authentication, authorization, request validation, rate limiting, and audit logging should be implemented in the relevant backend/API code—not only documented here.

## Scope and assumptions

- Region of focus: India.
- Expected stack in the current project README: Next.js, Node.js/Express/TypeScript, Prisma, PostgreSQL, Redis, and Python for ML/statistics.
- This is a planning document. A control is not considered implemented merely because it appears in this folder.
- Use synthetic or explicitly approved test data during development and demonstrations.
- Run tests only against systems and accounts the team owns or is authorized to test.

## Priority work

### P0 — Before demo or handling real data
- [ ] Keep secrets out of source control; use environment variables and a local `.env` file excluded by `.gitignore`.
- [ ] Validate all external input on the server, including coordinates, business identifiers, financial values, dates, and API parameters.
- [ ] Enforce server-side authentication and authorization on every protected route.
- [ ] Check object-level authorization: a user must not access or change another business's records by altering an ID.
- [ ] Use parameterized database access/Prisma safely; never build SQL by concatenating untrusted input.
- [ ] Apply safe error responses that do not expose stack traces, credentials, or internal details.
- [ ] Limit request sizes and add rate limits to sensitive or expensive endpoints.
- [ ] Restrict CORS to the frontend origins needed by the project.
- [ ] Protect sensitive data in transit with HTTPS in deployment and restrict access to stored data.
- [ ] Review dependencies and remove unused packages with known vulnerabilities.
- [ ] Use synthetic data in the demo; do not commit real customer, bank, or personal data.

### P1 — Integrity, auditability, and resilience
- [ ] Record security-relevant events: sign-in failures, authorization failures, sensitive record changes, score generation, and administrative actions.
- [ ] Include timestamp, actor/service identity, action, target record identifier, outcome, and request/correlation ID where appropriate.
- [ ] Never log passwords, tokens, full financial records, or other unnecessary sensitive values.
- [ ] Restrict log access and make logs append-oriented; consider centralized or tamper-evident storage if available.
- [ ] Track score inputs, model/version, data timestamps, and output so a result can be reviewed and reproduced.
- [ ] Treat climate API responses and other third-party data as untrusted; validate schema, freshness, units, and source.
- [ ] Define fallback behavior for unavailable or stale climate APIs; do not silently present stale data as current.
- [ ] Add timeouts and bounded retries for external services; use caching carefully and avoid serving stale data without indicating it.
- [ ] Ensure alerts do not expose confidential business details to unauthorized recipients.

### P2 — Additional hardening
- [ ] Add security-focused automated tests to CI or the project's test workflow.
- [ ] Review role permissions using least privilege.
- [ ] Consider stronger session/token protections, secret rotation, database backups, and recovery procedures.
- [ ] Assess ML-specific risks such as manipulated inputs, data poisoning, unauthorized model access, and leakage of sensitive training data.

## Initial threat model (STRIDE)

| Category | Example threat in this project | Initial mitigation |
|---|---|---|
| Spoofing | Attacker impersonates a business, bank officer, or service | Verified identity, secure authentication, service credentials |
| Tampering | Business financial values, location, climate inputs, or score history are altered | Server-side validation, authorization, constrained writes, audit trail |
| Repudiation | User denies changing a financial input or triggering a score | Security audit events with actor, time, target, and outcome |
| Information disclosure | One business sees another's financial data, or secrets appear in logs | Object-level authorization, least privilege, data minimization, secret-safe logs |
| Denial of service | API or climate provider is overloaded; scoring/alerts become unavailable | Rate limits, timeouts, bounded retries, caching, graceful degradation |
| Elevation of privilege | A regular user obtains officer/admin capabilities | Server-side role checks, deny-by-default permissions, tests for each role |

## Suggested audit event fields

Use only fields that are necessary and safe:
- `timestamp` (UTC)
- `actor_id` or service identity
- `action`
- `target_type` and `target_id`
- `outcome` (success/failure)
- `request_id` / correlation ID
- Minimal reason or event code

Do not record passwords, authentication tokens, API keys, or entire financial payloads. Restrict log access. A hash chain alone does not make logs tamper-proof if an attacker can rewrite both the logs and the hashes; protect logs with separate permissions or centralized storage where practical.

## Secure handling of climate and financial inputs

- Validate latitude and longitude ranges and reject malformed or missing coordinates.
- Validate financial values for expected type, range, currency/unit, and reporting period.
- Check data source, timestamp, units, and plausibility for climate data.
- Separate observed data, forecast data, synthetic/demo data, and user-entered values.
- Avoid treating a climate risk score as a definitive lending decision without review, explanation, and appropriate governance.
- Record enough provenance to explain which input data and model version produced a score.

## Development and collaboration rules

1. Never commit `.env`, API keys, tokens, private keys, production exports, or real customer data.
2. Use a `.env.example` containing placeholder values only.
3. Make small, reviewable changes on a feature branch and open a pull request.
4. Agree with the backend teammate on route names, roles, and audit-event format before implementing shared controls.
5. For each security feature, document: threat, control, code location, test, and status.
6. Do not mark an item complete until it is implemented and tested.

## Suggested folder layout

```text
security/
├── README.md
├── threat-model.md
├── security-checklist.md
├── audit-logging.md
└── tests/
    └── README.md
```

## Current status

This is an initial security plan. Update this section as work is implemented:
- Implemented: none confirmed in this document.
- In progress: to be agreed by the team.
- Not yet verified: all controls until tested against the current codebase.

