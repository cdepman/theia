# Project Theia — platform readiness

Checked 2026-11-21. Read-only checks only; no cloud resources were changed.

## Local project and Supabase

The build directory initially contained only `.env` and `.mcp.json`. The three requested environment variable names are present. Values were never printed or copied into generated files.

Both files target `ezcdosyfaugtemuboxmh`. Read-only requests to its `/rest/v1/` endpoint with each configured key returned **HTTP 401**. This is a failed credential/access check, not proof that the database is absent. The Supabase MCP connection available to this chat listed a different, inactive project; `get_project` for the intended reference returned permission denied. No query or migration was run against that unrelated project.

Before Phase 1 database work, correct the local keys and make the intended project accessible through MCP. Do not paste keys into chat. Verify the project is the dedicated Theia resource and inspect its schema before changes. A publishable key is not a migration credential, and working Data API credentials alone do not supply arbitrary SQL/migration access.

Node and npm are available. Supabase CLI reports **2.118.0**; Netlify CLI reports **26.0.1**. `docker` was not on PATH during this check; the required local Supabase integration-test stack has not been started. Check for an installed container runtime and arrange a working Docker-compatible runtime before database-backed gates. Do not claim those tests passed using mocks instead.

The initial sandboxed CLI checks failed because of network/local preferences restrictions. Re-running the read-only version/login checks with the required execution permissions succeeded. The initial sandboxed GitHub token warning was therefore not used as an authentication diagnosis.

## GitHub and Netlify

- GitHub CLI is authenticated as `cdepman` with repository/workflow scopes. No repository has been created or pushed.
- Netlify CLI is authenticated as Charlie Depman. It lists Star17, Ridepanda, and Charlie Depman's team. The current directory is not linked to a Netlify site.
- The personal `cdepman` team's account API reports **Free**, `credit_features=false`, `background_functions=true`, and no accumulating overages. Its reported allowances include 300 build minutes, 125,000 function invocations, 100 function GB-hours, and 1,000,000 Edge Function invocations. See [the filtered read-only account response](evidence/netlify-readiness.json). These are entitlements, not measured Theia usage or proof a deployed worker will execute.
- This is legacy metering, so a credit-based plan cannot be assumed. Proposed deviation: retain the existing Free plan, verify Background Function execution in Phase 1, and use the already-specified GitHub Actions worker fallback if necessary. Do not convert or upgrade the account automatically.
- The owner decision must confirm the destination team/plan. Existing sites and projects are outside the task's mutation scope.

## Current documentation checks

- [Netlify Background Functions](https://docs.netlify.com/build/functions/background-functions/) are documented for credit-based Free, Personal, Pro, and Enterprise plans; execution can run up to 15 minutes. The personal account's reported legacy-plan entitlement differs from the brief's blanket exclusion of lower legacy plans. Treat the account response as a reason to test, not as a verified runtime result.
- [Netlify pricing](https://www.netlify.com/pricing/) lists Free with 300 credits/month and Personal at $9/month with 1,000 credits. Production deploys cost 15 credits; compute is 10 credits/GB-hour. These are provider rates, **not measured Theia usage**. No upgrade or recharge was enabled.
- [Supabase pricing](https://supabase.com/pricing) lists Free at $0 with 500 MB database size, two active projects, and inactivity pausing after one week. The intended project's organization/plan/free-slot status could not be verified through the current MCP connection.
- The [Supabase changelog](https://supabase.com/changelog.md) was checked. The [CLI v3 breaking change](https://supabase.com/changelog/supabase-cli-v3) changes local/remote targeting and hosted-change confirmation. Do not mix v3 examples with the installed v2 command syntax.
- Supabase MCP documentation search was exercised. Recheck [API key guidance](https://supabase.com/docs/guides/api/api-keys) and [Data API hardening](https://supabase.com/docs/guides/api/hardening-data-api) when implementing: server-only secret, private internal schema, narrowly exposed API functions, explicit grants, and no anon/publishable access to Theia data.

No SQL latency, article storage size, function compute cost, credit consumption, CDN privacy behavior, or alert delivery has been measured. Those remain Phase 1/2 deliverables.

Research verification passed: every Python script parses, candidate IDs/domains are unique, each country has 15–25 candidates, all candidates are disabled, every configured feed has a final observation, all summary metrics reproduce from the saved records, JSON evidence parses, article bodies/summary text are absent, and the supplied key values do not appear in generated documentation, evidence, scripts, or registry files. These are research checks, not application acceptance tests.
