# Security Tests

Place tests here or in the application's established test directory, depending on the team's test framework.

## First tests to implement
1. Unauthenticated requests to protected endpoints are rejected.
2. A user with the wrong role cannot perform restricted actions.
3. A user cannot read or modify another business's record by changing an ID.
4. Invalid coordinates and malformed financial inputs are rejected server-side.
5. Error responses do not include stack traces, secrets, or sensitive payloads.
6. Rate limits and request-size limits behave as configured.
7. Climate provider errors and stale data produce safe, explicit fallback behavior.
8. Score generation and sensitive changes produce audit events without leaking sensitive values.

Use only the team's local/test environment and synthetic data. Coordinate endpoint names, roles, fixtures, and expected responses with the backend teammate before writing integration tests.

