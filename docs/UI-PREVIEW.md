# Restricted UI Preview

The UI-only Preview is a protected visual review of the public interface. It does not connect to a database, run migrations, call exchanges, produce signals, or execute trades.

Configure only the existing Vercel project `cryptohub` (`prj_RMBw9wXVJexXUMBGSMYScXNFkatL`) and the Preview branch `fix/scanner-sync-admin-id-clean`:

- Set `SMARTEXIT_UI_PREVIEW_ONLY=true` and `SMARTEXIT_UI_PREVIEW_BRANCH=fix/scanner-sync-admin-id-clean` in that branch's Preview scope only.
- Keep all database, Supabase-key, application-authentication, exchange, email, and CRON credentials absent. Set the supported trading and CRON gates to `false`.
- Keep Vercel Authentication / Require Log In enabled. This mode does not bypass user or administrator authorization.
- Vercel may inject its short-lived `VERCEL_OIDC_TOKEN` and build-only `VERCEL_ARTIFACTS_TOKEN`. The validator accepts the OIDC token only when its claims identify the approved team, project, and Preview environment; it accepts the artifacts token only in the trusted Vercel CI build for the exact Preview project and branch. Both are platform-managed; neither is an application credential, and the artifacts token is rejected at runtime.

The prebuild selects UI Preview validation only when the explicit flag is `true`; otherwise the existing full deployment validator remains in force. Run `npm run validate:ui-preview` to check the selected branch and safety wiring. In UI Preview, only the public landing page and static assets are available; database-dependent pages show “Unavailable in UI Preview,” and API requests are rejected.

Committing or pushing can trigger Vercel's connected Git deployment. Deployment approval remains separate; never promote this Preview to Production.
