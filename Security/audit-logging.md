# Audit Logging Guidance

## Events to consider
- Authentication success/failure and session/token invalidation
- Authorization failures and denied access to business records
- Creation or modification of business profiles and financial inputs
- Climate data refresh failures and stale-data fallback
- Risk-score generation, including model version and input/data timestamps
- Administrative role changes and configuration changes
- Alert delivery outcomes, without logging message secrets or unnecessary content

## Recommended fields
- UTC timestamp
- Actor ID or service identity
- Action/event code
- Target type and target ID
- Outcome
- Request/correlation ID
- Minimal reason code

## Do not log
- Passwords, access tokens, refresh tokens, API keys, private keys
- Full financial payloads when a minimal event is sufficient
- Unnecessary personal data
- Sensitive provider response bodies

## Integrity and access
- Keep log-writing permissions separate from ordinary application users.
- Restrict who can read and administer audit records.
- Prefer centralized or append-oriented storage where available.
- Monitor unexpected gaps, repeated failures, and changes to logging configuration.
- Do not call logs “tamper-proof” unless the design and tests justify that claim. A hash chain alone is insufficient if an attacker can rewrite the entire chain.

## Validation
Test that important actions create the expected event, sensitive values are redacted, unauthorized users cannot read or alter audit records, and failures do not expose secrets to clients.
