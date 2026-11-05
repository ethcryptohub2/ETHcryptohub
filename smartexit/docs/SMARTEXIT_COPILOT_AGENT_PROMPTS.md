# SmartExit — Complete Copilot Agent Instructions

> **Source of truth for the build.** Give this document to GitHub Copilot Chat in **Agent mode**. It contains the project requirements and complete phase prompts. The agent must implement code in the workspace, not merely provide advice.

## How to use this file

1. Create/open a folder named `smartExit` in VS Code.
2. Save this file as `docs/SMARTEXIT_COPILOT_AGENT_PROMPTS.md` in that project. If this downloaded file is outside the project, copy it into the project's `docs/` folder.
3. Open GitHub Copilot Chat, select **Agent** mode, and paste the **Master Agent Prompt** from Section 2.
4. Allow the agent to inspect files, create code, run commands, test, and fix issues.
5. If Agent mode stops because of context limits, paste the relevant **Phase Continuation Prompt** from Section 14. Do not ask it to redesign the project.

**Important:** This is a build specification, not an already-built application. Copilot must execute the implementation in the workspace. It must not claim success without running the commands and seeing the results.

---

# 1. Product requirements

## 1.1 Product identity

- Product name: **SmartExit**
- Goal: a safety-first, transparent **paper-trading** dashboard for testing trade exit rules.
- Core demo: create a simulated BTCUSDT position, submit simulated prices, activate trailing stop at TP1, retain full quantity at TP1 and TP2, close the full quantity at TP3 or stop-loss, persist state across restart, and display an auditable event timeline.
- Primary hackathon track to evaluate: **Unstoppable DeFi**.
- AI Security & Defense is only a possible secondary fit if implemented risk policies and security guardrails are genuinely demonstrated.
- User environment: Windows 10/11, PowerShell, 8 GB RAM, beginner coder, budget-conscious, local-first.
- Default mode: `PAPER`. No live exchange orders or real-money trading in the MVP.

## 1.2 Non-negotiable rules

1. Do not add live spot/futures order execution, exchange credentials, leverage, or real-money order placement.
2. Do not pretend simulated prices, P&L, token lists, quotes, swaps, or transactions are real.
3. NEAR Intents is a separate token-swap integration. It is not the SmartExit futures order engine.
4. Never invent API endpoints, response schemas, token IDs, chain IDs, transaction hashes, adoption statistics, or successful tests.
5. If an external API or credential is missing, implement an honest `NOT_CONFIGURED` state and continue the rest of the project.
6. Never commit `.env`, API keys, private keys, seed phrases, credentials, local databases, or logs.
7. The backend is the source of truth for state transitions and risk checks.
8. No partial exits at TP1 or TP2. The whole simulated position closes at TP3 or a protective stop.
9. The kill switch must not delete trades or event history.
10. Ask the user only if something is truly blocking and cannot safely be defaulted. Otherwise choose the safest reasonable default, document it, and continue.

## 1.3 Default stack

- Frontend: React + Vite + TypeScript.
- Backend: Node.js + TypeScript + Express.
- Database: SQLite with migrations.
- Validation: Zod.
- Tests: Vitest; add Playwright only if it remains lightweight and useful.
- Package manager: npm.
- OS commands: Windows PowerShell.
- Avoid requiring Docker.
- Use strict TypeScript and keep dependencies appropriate for an 8 GB machine.

If a working repository already uses a suitable stack, inspect it first and preserve useful code. Do not rewrite a working project for stylistic reasons. If changing the stack is genuinely necessary, explain why in `docs/ARCHITECTURE.md` and continue without asking routine preference questions.

---

# 2. Master Agent Prompt — copy the entire prompt below

```text
You are the lead engineer and autonomous implementation agent for SmartExit. Build the actual working application in this VS Code workspace. Do not merely produce a plan or sample snippets.

FIRST ACTION
- Inspect the current workspace, package files, existing source code, and available scripts.
- Preserve useful working code. If the workspace is empty, scaffold the project from scratch.
- Create/update docs/BUILD_STATUS.md with a checklist for every phase in this specification.
- Create/update docs/SMARTEXIT_COPILOT_AGENT_PROMPTS.md if this specification is not already in the repo. Treat it as the source of truth.
- Start Phase 1 immediately and continue through the phases without asking for approval after every step.

AUTONOMOUS WORK RULES
- Do not ask me routine choices that are already answered by this specification.
- For unspecified non-blocking details, choose the safest conventional default, record the choice in docs/ARCHITECTURE.md, and proceed.
- If a real API credential/config is absent, implement NOT_CONFIGURED and continue. Do not block the whole project.
- If a dependency or command fails, inspect the exact error, fix it, and retry.
- Do not claim tests, lint, type-check, build, security checks, or features passed unless you actually ran and verified them.
- Work in small phases, but continue autonomously until done or a genuine environment limitation blocks progress.
- Do not overwrite or delete user data without need. Before a destructive migration or removal, preserve data or choose a safe migration.
- At the end, give exact PowerShell commands, URLs, test results, incomplete items, and one next action in beginner-friendly language.

PRODUCT
SmartExit is a transparent, safety-first PAPER-TRADING trade-management dashboard. It simulates a position through TP1, TP2 and TP3; activates trailing stop after TP1; logs all transitions; persists state; applies risk controls; and has a separate NEAR Intents status panel.

Environment: Windows 10/11, PowerShell, 8 GB RAM, beginner developer, local-first, npm. Primary hackathon track to evaluate: Unstoppable DeFi. Consider AI Security & Defense only if implemented risk policy/guardrails substantiate the claim.

SAFETY BOUNDARIES
- Paper trading only. No real exchange order placement, exchange API keys, real-money execution, or leverage.
- Do not fake any external API data.
- NEAR Intents token swap integration is separate from simulated futures exit logic.
- Do not claim NEAR Intents directly executes centralized exchange futures orders.
- Use .env.example with placeholders. Ensure real .env, secrets, DB files and logs are gitignored.
- External integration missing config => honest NOT_CONFIGURED response and working app.
- Any feature that cannot be verified must be marked incomplete, not represented as finished.

STACK
Use React + Vite + TypeScript frontend, Node.js + TypeScript + Express backend, SQLite migrations, Zod schemas, Vitest tests, npm. Use a clear monorepo if starting fresh. Keep dependencies light. Add strict TypeScript, ESLint, Prettier, scripts for dev, test, lint, typecheck and build.

REQUIRED SCREENS
A. Dashboard:
- PAPER MODE banner and “No live exchange orders are sent” warning.
- Backend/database health, open positions, today’s realized simulated P&L, daily risk use, recent events and kill-switch state.
- Open trades table with symbol, side, entry/current price, status, TP progress, stop/trailing stop, simulated P&L, details link.
B. Create Paper Trade:
- symbol default BTCUSDT, side LONG/SHORT, entry price, quantity, initial stop, TP1/TP2/TP3, trailing percent default 1.0, optional notes.
- Client and server validation. Show risk estimate before submit.
- Never silently reorder levels.
C. Trade Detail:
- all trade parameters, current simulated price, P&L, status, trailing stop, event timeline.
- manual simulated-price update form requiring a unique event ID. UI can generate UUID for every update.
D. Risk Settings:
- paper equity, max open positions, max risk/trade, max daily loss, kill switch.
- backend enforces all policies.
E. NEAR Intents:
- status NOT_CONFIGURED / CONFIGURED / CONNECTED / ERROR.
- only show real token lists, quotes and swap states from actual verified provider responses.
- honest empty state if not configured.
- explicitly distinguish token swaps from SmartExit’s paper futures simulation.

TRADE STATE MACHINE
Statuses:
OPEN
TP1_HIT_TRAILING
TP2_HIT_TRAILING
COMPLETED_TP3
STOPPED_INITIAL_SL
STOPPED_TRAILING_SL
CANCELLED

Valid level ordering:
- LONG: initialStop < entry < TP1 < TP2 < TP3.
- SHORT: TP3 < TP2 < TP1 < entry < initialStop.

LONG behaviour:
- Initial stop hit before TP1 => close full quantity; STOPPED_INITIAL_SL.
- TP1 crossed => TP1_HIT_TRAILING, activate trailing; do not partially close.
- TP2 crossed => TP2_HIT_TRAILING; keep trailing active; do not partially close.
- TP3 crossed => close full quantity; COMPLETED_TP3.
- After trailing activation, maintain highest price since TP1. Trailing stop = highestPrice * (1 - trailingPercent/100). It may only rise.

SHORT behaviour:
- Initial stop hit before TP1 => close full quantity; STOPPED_INITIAL_SL.
- TP1 crossed => TP1_HIT_TRAILING, activate trailing; do not partially close.
- TP2 crossed => TP2_HIT_TRAILING; do not partially close.
- TP3 crossed => close full quantity; COMPLETED_TP3.
- After trailing activation, maintain lowest price since TP1. Trailing stop = lowestPrice * (1 + trailingPercent/100). It may only fall.

- TP1 and TP2 are milestones, not partial exits. Quantity remains unchanged.
- Terminal states are immutable.
- If one simulated tick could cross both a protective stop and a target, protective stop wins. Document this conservative simplified simulation rule.
- Process each price event deterministically and transactionally.

P&L simplified formula; exclude fees, funding, slippage, liquidation and contract multipliers:
LONG = (exitOrCurrentPrice - entryPrice) * quantity
SHORT = (entryPrice - exitOrCurrentPrice) * quantity
Show this limitation in UI and README. This is a simulator, not financial advice.

RISK GUARDIAN
- max open paper positions default 3.
- max simulated risk per trade default 1% of configured paper equity.
- daily loss limit default 3% of starting daily paper equity.
- on reaching daily loss limit, block new positions until next UTC day or an explicit safe reset.
- kill switch blocks new positions and pauses automated simulated price processing; it must not erase trades/history.
- all checks on backend.
- finite positive numbers only; reject NaN/infinity/zero/negative price or quantity.
- trailing percent > 0 and <= 25.
- estimated risk = absolute(entry - initialStop) * quantity. Reject if above risk budget and explain why.
- tests must verify all policies.

SQLITE DATA MODEL
Use migrations, UTC ISO timestamps, parameterized SQL and transactions.

trades:
id UUID PRIMARY KEY, symbol, side, status, entry_price, quantity, initial_stop, tp1, tp2, tp3, trailing_percent, trailing_active, trailing_stop nullable, highest_price_since_tp1 nullable, lowest_price_since_tp1 nullable, current_price, exit_price nullable, realized_pnl nullable, created_at, updated_at, closed_at nullable, notes nullable.

trade_events:
id UUID PRIMARY KEY, trade_id FK, event_key UNIQUE, event_type, event_payload_json, created_at.

risk_settings:
singleton id=1, paper_equity, max_open_positions, max_risk_per_trade_percent, max_daily_loss_percent, kill_switch_enabled, updated_at.

daily_stats:
day_utc PRIMARY KEY, starting_equity, realized_pnl default 0, new_trades_blocked.

app_settings:
key PRIMARY KEY, value_json, updated_at.

Price update must run in a DB transaction: check event key, load trade, validate state, compute transition, update trade, insert event, update daily stats if closing. A duplicate event key must not reprocess P&L or add another event. On restart, restore open positions/settings; never close a position merely because the process restarted. Validate persisted data and log a recovery event if needed.

API CONTRACT
GET /api/health
GET /api/trades
POST /api/trades
GET /api/trades/:id
POST /api/trades/:id/price (body includes eventId and price)
POST /api/trades/:id/cancel
GET /api/risk
PUT /api/risk
POST /api/risk/kill-switch
GET /api/events
GET /api/near-intents/status
GET /api/near-intents/tokens
POST /api/near-intents/quote
POST /api/near-intents/swap (disabled by default; if no verified provider config, return explicit NOT_CONFIGURED/disabled response).

Use Zod for all request validation. Use consistent JSON response shapes, appropriate status codes, safe error messages, no stack traces or secrets in browser responses. Add pagination/filtering if reasonable.

NEAR INTENTS INTEGRATION
- Before writing any provider requests, read https://docs.near-intents.org/ and official current 1Click Swap API docs linked from there.
- Do not guess endpoint URLs, schemas, token IDs, chain IDs, auth requirements or payload fields.
- Put integration behind apps/api/src/services/near-intents-adapter.ts.
- If config is absent, status is NOT_CONFIGURED.
- A quote is real only after actual successful provider response.
- A request ID alone does not prove final settlement.
- Swap submission stays disabled by default unless it can be implemented from official docs with explicit user confirmation and tests. If not safe/possible, document it as disabled and finish other features.
- Do not invent transaction hashes, balances, fees, tokens, adoption metrics or provider success.

REQUIRED STRUCTURE (adapt only for a clear technical reason)
smartExit/
  README.md
  .gitignore
  .env.example
  package.json
  docs/
    SMARTEXIT_COPILOT_AGENT_PROMPTS.md
    BUILD_STATUS.md
    ARCHITECTURE.md
    API.md
    TEST_PLAN.md
    DEMO_SCRIPT.md
  apps/web/ (React/Vite/TS)
  apps/api/ (Express/TS, routes, schemas, services, migrations, repositories, tests)
  packages/shared/ (shared types and schemas)
  data/ (ignored local SQLite)
  .github/workflows/ci.yml

QUALITY AND SECURITY
- strict TypeScript, ESLint, Prettier, Vitest.
- backend owns state transitions; UI never owns authoritative state.
- parameterized SQL, migrations and DB transactions.
- idempotent price event processing.
- clear loading/empty/error states and accessible labels.
- gitignore node_modules, dist/build, .env*, SQLite db/wal/shm, logs and temporary files. Keep .env.example tracked.
- no secrets in logs.
- no fake fixtures presented as live data; fixtures must be visibly marked DEMO.
- tests for LONG/SHORT, invalid ordering, TP1, TP2 without partial exit, TP3 full exit, initial SL, trailing SL, monotonic trailing, same-tick stop priority, terminal immutability, risk limit, daily loss block, kill switch, duplicate event, persistence/restart, API validation and missing NEAR config.
- README, architecture, API docs, test plan, demo script, build status and CI workflow.

IMPLEMENTATION PHASES — DO NOT STOP AFTER PLANNING
Phase 1: inspect workspace, create BUILD_STATUS, scaffold, scripts, health route; start frontend/backend.
Phase 2: SQLite migrations/repos, validation, health/trade/risk/events API and API tests.
Phase 3: trade state machine, trailing stop, P&L, idempotency, event log and unit tests.
Phase 4: risk guardian, kill switch, daily limit, restart recovery and tests.
Phase 5: all UI screens wired to real backend.
Phase 6: NEAR Intents adapter with honest NOT_CONFIGURED state; actual read-only integration only from verified docs/config.
Phase 7: run tests, lint, type-check, build; fix failures; test restart and duplicate event.
Phase 8: README/docs/demo steps/CI/git hygiene and final verification.

ACCEPTANCE CRITERIA
A beginner on Windows can follow README and run the app. They can create a simulated BTCUSDT trade, submit prices, see TP1 trailing activation, see TP2 without partial close, close full quantity at TP3 or stop, restart and retain state, use kill switch, inspect audit events, and see NEAR status without fake data. Tests pass. No live exchange order can be sent. No secrets are committed.

FINAL REPORT
When implementation is actually complete, report:
1. files/features created;
2. exact PowerShell commands;
3. URLs to open;
4. exact commands run and their real results;
5. incomplete items and why;
6. one next action for me.
Now inspect the workspace and implement Phase 1 immediately. Continue through the remaining phases without asking routine questions.
```

---

# 3. Required build-status file

Copilot must create `docs/BUILD_STATUS.md` and keep it current. Use this checklist:

```markdown
# SmartExit Build Status

## Phase 1 — Scaffold
- [ ] Inspect existing workspace
- [ ] Create/verify project structure
- [ ] Configure scripts and TypeScript
- [ ] Frontend starts
- [ ] Backend starts
- [ ] Health route works

## Phase 2 — API and persistence
- [ ] SQLite migrations
- [ ] Repositories and transactions
- [ ] Zod schemas
- [ ] Trade/risk/event routes
- [ ] API tests

## Phase 3 — Trade engine
- [ ] LONG rules
- [ ] SHORT rules
- [ ] TP1 trailing activation
- [ ] TP2 no partial close
- [ ] TP3 full close
- [ ] Initial/trailing stop
- [ ] Idempotency
- [ ] Event audit
- [ ] Unit tests

## Phase 4 — Risk and recovery
- [ ] Max open positions
- [ ] Per-trade risk
- [ ] Daily loss limit
- [ ] Kill switch
- [ ] Restart recovery
- [ ] Tests

## Phase 5 — UI
- [ ] Dashboard
- [ ] Create trade
- [ ] Trade detail
- [ ] Risk settings
- [ ] Event timeline
- [ ] Loading/empty/error states
- [ ] API wiring

## Phase 6 — NEAR Intents
- [ ] Official docs reviewed
- [ ] Adapter boundary
- [ ] Honest NOT_CONFIGURED state
- [ ] No fake data
- [ ] Integration tests or documented blocker

## Phase 7 — Quality
- [ ] Tests run
- [ ] Lint run
- [ ] Type-check run
- [ ] Build run
- [ ] Restart test
- [ ] Duplicate event test
- [ ] No secrets committed

## Phase 8 — Docs and submission
- [ ] README
- [ ] Architecture
- [ ] API docs
- [ ] Test plan
- [ ] Demo script
- [ ] CI workflow
- [ ] Hackathon rules re-checked
```

---

# 4. Phase 1 prompt — scaffold and run

Use this if you want to run the build phase-by-phase, or if Copilot stops after planning:

```text
Implement Phase 1 only, but do real file work. Inspect the workspace first and preserve useful files. Create/update docs/BUILD_STATUS.md and docs/ARCHITECTURE.md. Scaffold React/Vite/TypeScript frontend and Express/TypeScript backend using npm and lightweight dependencies. Configure strict TypeScript, lint, format, test, typecheck, build and dev scripts. Add GET /api/health that reports app mode PAPER and SQLite connectivity status (the database may be initialized in this phase). Add .gitignore and .env.example with placeholders only. Make frontend and backend start successfully. Run the commands, fix errors, update BUILD_STATUS with exact outcomes, then proceed to Phase 2 unless a genuine environment limitation blocks you. Do not ask routine questions.
```

# 5. Phase 2 prompt — SQLite and API

```text
Implement Phase 2 against this specification. Create SQLite migrations and repositories for trades, trade_events, risk_settings, daily_stats and app_settings. Use parameterized SQL and transactions. Add Zod schemas and routes: GET /api/health, GET/POST /api/trades, GET /api/trades/:id, POST /api/trades/:id/price, POST /api/trades/:id/cancel, GET/PUT /api/risk, POST /api/risk/kill-switch, GET /api/events, GET /api/near-intents/status, GET /api/near-intents/tokens, POST /api/near-intents/quote, POST /api/near-intents/swap. For the price route, enforce an eventId. Keep NEAR routes honest and NOT_CONFIGURED until the real provider is configured. Use consistent response shapes and safe errors. Add route tests and update docs/API.md and BUILD_STATUS. Run tests and fix failures. Do not add live exchange order execution.
```

# 6. Phase 3 prompt — trade engine

```text
Implement the trade engine as a backend service with unit tests. Follow the exact LONG/SHORT ordering, TP1 trailing activation, TP2 milestone without partial exit, TP3 full close, initial stop and trailing stop rules in the master specification. Terminal states must be immutable. Trailing stop must be monotonic in the safe direction. Use the conservative same-tick rule: protective stop wins. Calculate simplified P&L and clearly disclose excluded fees/slippage/funding/multipliers. Process each event transactionally and idempotently; a repeated eventId must not change state, duplicate events or double-count P&L. Add comprehensive Vitest cases for every state transition and invalid inputs. Do not implement logic in React components. Update docs/TEST_PLAN.md and BUILD_STATUS; run tests and fix failures.
```

# 7. Phase 4 prompt — risk guardian and recovery

```text
Implement the backend Risk Guardian and restart recovery. Defaults: max 3 open positions, 1% paper equity max risk per trade, 3% daily loss limit, trailing percent >0 and <=25%. Estimated risk = abs(entry - initialStop) * quantity. Block invalid/high-risk positions server-side. When daily loss limit is hit, block new positions until next UTC day or safe reset. Kill switch blocks new trades and pauses automated simulated price processing; it never deletes trades/events. On restart, restore open trades/settings from SQLite and validate them without closing positions just because of restart. Add tests for all limits, kill switch, UTC day boundary, recovery and event audit. Update docs and BUILD_STATUS; run and fix tests.
```

# 8. Phase 5 prompt — frontend

```text
Implement the full React UI and wire it to the actual backend API. Required screens: Dashboard, Create Paper Trade, Trade Detail, Risk Settings, NEAR Intents status. Use a clean, readable, responsive layout that performs well on an 8 GB Windows PC. Show PAPER MODE and "No live exchange orders are sent" persistently. Add loading, empty, validation and error states; accessible labels; confirmation for kill switch; event timeline; simulated price update form with unique event ID. The UI must never be the authority for trade status or risk checks. Do not show fake external API results. Add practical frontend tests if feasible, run all checks, and update BUILD_STATUS.
```

# 9. Phase 6 prompt — NEAR Intents adapter

```text
Implement only a clean, separately testable NEAR Intents adapter. First read current official documentation at https://docs.near-intents.org/ and its official 1Click Swap API references. Verify exact endpoints, auth, schemas and status semantics before coding. Never guess. The app must work without credentials and report NOT_CONFIGURED. Do not fabricate tokens, quotes, transaction hashes, balances or settlement. Do not connect this adapter to simulated futures TP/SL logic. Keep swap submission disabled by default unless official docs, configuration, confirmation and tests make it safe. If real integration cannot be verified in this environment, finish the honest status panel and document exact missing setup; continue other tasks. Add adapter tests and update docs/BUILD_STATUS.
```

# 10. Phase 7 prompt — verification and bug fixing

```text
Run the complete project verification now. Inspect package scripts and run the actual commands for unit/API tests, lint, TypeScript type-check, production build and any configured UI tests. Do not report success unless each command actually passes. Fix errors in the code, then rerun the failing command and the full suite. Verify: create LONG/SHORT; invalid levels rejected; TP1 activates trailing; TP2 does not reduce quantity; TP3 closes all; initial and trailing stops close all; trailing is monotonic; duplicate eventId is idempotent; kill switch blocks new trade; daily loss blocks new trade; restart retains state; missing NEAR config shows NOT_CONFIGURED; no secrets/local DB are tracked. Update docs/TEST_PLAN.md and BUILD_STATUS with command output summaries and any known limitation.
```

# 11. Phase 8 prompt — README, demo and submission preparation

```text
Prepare project documentation and submission materials without inventing facts. Create/update README.md with Windows PowerShell setup, prerequisites, exact install/dev/test/lint/typecheck/build commands, URLs, environment variables, troubleshooting, architecture summary, paper-mode warning, simplified P&L limitations and NEAR Intents integration status. Update docs/ARCHITECTURE.md, docs/API.md, docs/TEST_PLAN.md and docs/DEMO_SCRIPT.md. Add a lightweight GitHub Actions workflow for install, lint, typecheck, tests and build if the workspace supports it. Check .gitignore and inspect git status for secrets, .env, database and logs. Re-check current official hackathon rules at https://nearhackathon.com/#apply before writing dates or requirements. Create a 2–3 minute demo flow and a final checklist. Do not claim deployment, user adoption, transactions or tests that did not happen.
```

# 12. Acceptance test matrix

| Scenario | Expected result |
|---|---|
| Create valid LONG | OPEN paper trade and creation event |
| Create valid SHORT | OPEN paper trade and creation event |
| Invalid target order | Clear validation error, no database row |
| LONG reaches TP1 | Trailing activates, quantity unchanged |
| Reaches TP2 | State changes, quantity unchanged |
| Reaches TP3 | Entire quantity closes, terminal state |
| Initial stop hit | Full close before TP1 |
| Trailing stop hit | Full close, reason recorded |
| Price retraces after trail rises | LONG trailing stop never falls; SHORT trailing stop never rises |
| Duplicate eventId | No duplicate event or P&L |
| Kill switch enabled | New trade blocked, history preserved |
| Daily loss limit reached | New trade blocked, reason displayed |
| Backend restart | Open positions/settings restored |
| NEAR config absent | NOT_CONFIGURED; no fake quote/token |
| Git check | No credentials, local DB or logs committed |

# 13. Suggested demo sequence

1. Open dashboard; show PAPER MODE and risk controls.
2. Create a LONG BTCUSDT paper trade with valid levels.
3. Submit simulated price crossing TP1; show trailing activation and audit event.
4. Submit price crossing TP2; prove quantity is unchanged.
5. Submit price crossing TP3 or the trailing stop; show full closure and simulated P&L.
6. Restart backend and show state/history persisted.
7. Enable kill switch and show a new trade is rejected.
8. Open NEAR Intents panel; show actual configured status or honest NOT_CONFIGURED.
9. Show passing tests and public repository, while stating limitations honestly.

# 14. Phase continuation prompt — if Copilot loses context

```text
Continue implementing SmartExit using docs/SMARTEXIT_COPILOT_AGENT_PROMPTS.md as the source of truth. First inspect docs/BUILD_STATUS.md, current workspace files, package scripts, git status and the most recent test/build results. Do not restart from scratch or ask routine questions. Identify the first unchecked item, implement it in the existing codebase, run relevant tests, fix failures, update BUILD_STATUS, and continue to the next unchecked item. Preserve working code and all safety rules: paper trading only, no live exchange orders, no fake NEAR Intents data, backend-owned risk/state, idempotent events, and no secrets in git. Continue until all acceptance criteria pass or a genuine blocker remains. Report only work actually completed and commands actually run.
```

# 15. Final submission checklist

- [ ] Current hackathon rules, dates, track names and eligibility checked at https://nearhackathon.com/#apply.
- [ ] Public repository contains source, README, architecture, API docs, test plan and demo script.
- [ ] Windows setup commands work from a clean checkout.
- [ ] Automated tests, lint, type-check and build run successfully.
- [ ] Demo clearly identifies paper simulation and any real external API data.
- [ ] No real exchange order execution is present.
- [ ] No secrets, `.env`, local SQLite DB, logs or private keys are committed.
- [ ] No fake adoption metrics, transactions, token quotes or test results.
- [ ] Public demo post/video/screenshots meet the current official requirements.
- [ ] Incomplete integrations are disclosed honestly.

## Official links

- NEAR Hackathon: https://nearhackathon.com/#apply
- NEAR Intents documentation: https://docs.near-intents.org/
- Node.js: https://nodejs.org/en/download
- GitHub Copilot documentation: https://docs.github.com/en/copilot
