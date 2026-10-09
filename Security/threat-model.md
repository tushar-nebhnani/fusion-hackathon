# Threat Model — Climate-Adjusted Financial Risk Score

## System assets
- Business identity, location, and profile
- Daily sales and financial indicators
- Climate observations, forecasts, and exposure records
- Risk scores, score explanations, and decision history
- User sessions, roles, API credentials, and database credentials
- Audit records and outgoing alerts
- Model files, model configuration, and training data

## Trust boundaries
1. Browser/frontend to backend API
2. Backend API to PostgreSQL/Redis
3. Backend to climate/weather/satellite data providers
4. Backend to Python scoring/ML service
5. Backend to email/SMS/WhatsApp providers
6. Developer machines and CI to the shared repository/deployment environment

## STRIDE scenarios

| ID | Threat | Impact | Mitigation / verification |
|---|---|---|---|
| S-01 | A user impersonates another business or officer | Unauthorized data access or score changes | Authenticate users; verify identity and role server-side; test invalid/expired credentials |
| T-01 | A request changes another business's record by editing its ID | Financial data or risk score manipulated | Object-level authorization for every read/write; test cross-business access |
| T-02 | A client submits false sales, location, or business-category data | Misleading risk score | Server-side schema and range validation; authorization and provenance checks |
| T-03 | A third-party climate response is malformed or stale | Incorrect exposure estimate | Validate schema, units, timestamps, source and freshness; label fallback/stale results |
| R-01 | A user denies changing inputs or triggering a score | Dispute cannot be investigated | Record actor, timestamp, action, target, outcome and request ID |
| I-01 | API response reveals another business's financial details | Privacy and confidentiality breach | Minimize response fields; object-level authorization; test access boundaries |
| I-02 | Logs or error responses expose tokens, secrets, or financial payloads | Credential compromise or data leakage | Redact logs; generic external errors; secret scanning |
| D-01 | High request volume or slow climate API prevents scoring | Service outage or delayed alerts | Rate limiting, timeouts, bounded retries, caching and graceful degradation |
| E-01 | A normal user can invoke admin-only operations | Unauthorized changes or data access | Deny-by-default RBAC; central authorization middleware; role-matrix tests |
| ML-01 | Inputs are deliberately manipulated to influence model output | Unreliable score or unfair lending outcome | Input provenance, anomaly checks, versioned model/input records, human review |
| SUP-01 | A secret or vulnerable dependency is committed to the repo | Account compromise or exploitable application | `.gitignore`, secret scanning, dependency review, least-privilege credentials |

## Risk prioritization

Prioritize threats that can expose or alter financial records, bypass authorization, leak credentials, or corrupt score inputs. Assign likelihood and impact after reviewing the actual implementation; do not claim a risk is resolved until a mitigation has been tested.

## Questions to resolve with the team
- Which user roles exist (business owner, analyst/officer, admin, service)?
- Which endpoints read or modify business records and risk scores?
- Is the ML/scoring service inside the backend process or a separate service?
- Which climate-data sources are called, and how is freshness represented?
- Which audit storage is available and who can modify it?
- What data is synthetic versus real in the demo?

