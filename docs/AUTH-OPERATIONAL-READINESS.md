# Authentication operational readiness

This release changes application code only; it does not change passwords, sessions, email verification state or Staging rows during validation.

## Implemented and independently tested

`lib/auth-routes.ts` now removes an undelivered verification code after email failure. Cleanup matches both user and issued hash, so a failing older request cannot delete a newer resend. Verification hashes use the existing timing-safe comparison. `/api/auth/me` responses explicitly use `Cache-Control: no-store`.

`lib/auth-routes.security.test.mjs` exercises actual route code with mocked transport/storage: failed signup delivery cleanup, enumeration-safe reset delivery failure cleanup, successful reset transaction ordering, same-user session revocation, single-use code consumption and noncacheable identity responses. Existing verification, rate-limit, CSRF, expired/locked code and missing-schema tests remain.

`lib/auth-session-isolation.test.mjs` loads the actual session and account/notification routes against two populated in-memory identities and session rows. It checks the exact expiry boundary, logout/revocation, inactive/unverified users, Admin rejection, hashed token persistence, HTTP-only/strict cookies, forged account IDs, cross-user mark-read attempts and identity changes. The database double enforces the expiry/active/verified and ownership predicates from the query; it does not prove deployed Postgres RLS or arbitrary query semantics. Subscription authorization is stubbed as eligible to isolate tenant ownership. No outbound email or remote fixture is created.

## Remaining external checks

- Staging lacks `public.auth_password_reset_codes`. The current reset endpoint remains unavailable until separately approved `202611140001_password_recovery.sql`, after verified backup/restore readiness. That file can be approved independently of exchange migrations.
- Live signup/email delivery and full verification still require an unused authorized test mailbox and explicit permission for disposable account creation and outbound verification email. The operator previously chose to skip this; no new signup was attempted.
- A real controlled expiry/revocation test requires an explicitly authorized disposable session fixture. No existing customer/admin session expiry or credentials were modified. Offline expiry tests do not certify live cookie/proxy/database behavior.
- Successful password-reset end-to-end testing changes a credential and revokes sessions. It requires a disposable account and private operator completion; it is not bundled with this release.
- Populated mock isolation covers actual application scoping. Database row-level attacks require an approved disposable database with real grants/policies; do not infer that unapplied private-schema RLS is tested.

Email verification, CSRF and existing rate limits remain required. No credentials or notification settings are enabled by this work.
