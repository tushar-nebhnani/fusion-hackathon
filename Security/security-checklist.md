# Security Checklist

Use the status values `Not started`, `In progress`, `Implemented`, and `Tested`. “Implemented” does not mean “Tested.”

| Priority | Control | Status | Owner / code location | Evidence / test |
|---|---|---|---|---|
| P0 | Secrets excluded from Git; `.env.example` uses placeholders | Not started | TBD | Secret scan and repo review |
| P0 | Authentication on protected endpoints | Not started | TBD | Missing/invalid token tests |
| P0 | Server-side RBAC and deny-by-default access | Not started | TBD | Role matrix tests |
| P0 | Object-level authorization for each business record | Not started | TBD | Cross-business read/write tests |
| P0 | Server-side input validation | Not started | TBD | Invalid type/range/schema tests |
| P0 | Safe database access; no raw string-concatenated SQL | Not started | TBD | Code review and injection tests |
| P0 | Safe error responses | Not started | TBD | Confirm no stack traces/secrets returned |
| P0 | Rate limiting and request-size limits | Not started | TBD | Controlled limit test |
| P0 | Restrictive CORS configuration | Not started | TBD | Allowed/disallowed origin tests |
| P0 | Sensitive data excluded from logs and demo fixtures | Not started | TBD | Log review and fixture review |
| P1 | Audit events for sensitive changes and score generation | Not started | TBD | Event assertions in tests |
| P1 | Audit log access restricted | Not started | TBD | Permission review |
| P1 | Climate data schema/freshness validation | Not started | TBD | Malformed/stale provider response tests |
| P1 | Timeout/retry/fallback behavior for external APIs | Not started | TBD | Simulated provider failure |
| P1 | Score provenance includes input timestamps/model version | Not started | TBD | Score traceability test |
| P1 | Dependency vulnerability review | Not started | TBD | Package audit output |
| P2 | Automated security checks in CI | Not started | TBD | CI run |
| P2 | Backup/recovery and secret rotation plan | Not started | TBD | Documented procedure |

## Findings log

For each finding, record:
- ID and date
- Affected component/endpoint
- Preconditions and reproducible steps (use test data)
- Impact and severity, with rationale
- Evidence that avoids exposing secrets or personal data
- Proposed fix and owner
- Retest result and date

Do not include real credentials, tokens, or customer financial data in this file.
