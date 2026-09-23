# CLAUDE.md

Guidance for Claude Code and the automated PR review workflow
(`.github/workflows/claude-code-review.yml`) when working in this repo.

## What this project is

Gadget Tracker — a warehouse/IT-asset tracking app (gadgets, inventory
assets, warehouses/locations, requisitions, user accounts) backed by
Supabase (Postgres + Auth + Realtime). See `MIGRATION_GUIDE.md` for how
it moved from `localStorage` to Supabase, `AUTH_GUIDE.md` for the login
system, and `self-hosting-supabase-guide.md` for running the backend
without Supabase's cloud.

## Architecture — read this before suggesting structural changes

- **No build step, no framework.** Plain `<script type="module">`
  against local files — no bundler, no npm dependency for the app
  itself, no package.json. `index.html` loads `env.js` as a plain
  script, then `js/app.js` as a module. Don't suggest introducing
  Webpack/Vite/React/etc. unless the PR itself is about that.
- **`js/features/<name>/`** — one folder per feature (`manage`,
  `inventoryAssets`, `reports`, `requisition`, `settings`,
  `userManagement`, `auth`), each with a `Controller.js` (state +
  store wiring + event handlers) and a `View.js` (DOM
  rendering/templates), plus a `Form.js` where the feature has one.
- **`js/core/`** — cross-cutting singletons: `Store.js`/
  `SupabaseStore.js` (the data layer, see below), `Auth.js`,
  `supabaseClient.js`/`supabaseConfig.js`, `EventBus.js`,
  `TabManager.js`, `WarehouseScope.js`, `Operator.js`,
  `EmployeeSession.js`, `Permissions.js`.
- **`js/models/`** — plain entity classes (`Gadget`, `InventoryAsset`,
  `Requisition`, `UserAccount`, `UserGroup`, `Warehouse`,
  `WarehouseLocation`) — validation and small domain methods (e.g.
  `Gadget.addLogEntry`), not framework classes.
- **`js/components/`** — reusable UI widgets shared across features
  (`Modal`, `Toast`, `DropdownMenu`, `ConfirmDialog`, `Pagination`,
  `LogModal`, etc.).
- **`js/utils/`** — pure helpers with no DOM/store dependencies
  (`csv.js`, `format.js`, `dom.js`, `id.js`, `pagination.js`,
  `merchantPlacement.js`, `passwordPolicy.js`).

## The store pattern

`SupabaseStore` is a drop-in replacement for the older `Store.js`
(same `list/get/create/update/delete` API, same `'change'` events) —
see `MIGRATION_GUIDE.md` for the full reasoning. Key things to know
before touching a controller:

- Reads (`list`/`get`) are synchronous against an in-memory cache —
  no controller code awaits a read.
- Writes are optimistic: the cache updates and `'change'` fires
  immediately, then the Supabase request fires in the background. A
  failed write rolls the cache back and fires `'error'`.
- Every controller's `init()` subscribes to `store.on('change', ...)`
  and re-renders; this is the reactive loop the whole UI runs on.
  Don't add polling or manual re-render calls where a store event
  would do.

## Documentation style — match it

Doc comments in this codebase are long-form and explain **why**, not
just what — historical reasoning, trade-offs considered and rejected,
edge cases and the bug they were added for. See `js/utils/csv.js`'s
`escapeCell` or `supabase/schema.sql`'s trigger comments for the
standard to match. A one-line `// what this does` comment on a
non-obvious decision is under this project's bar — prefer explaining
the reasoning the same way the surrounding code already does, rather
than flagging "missing comment" as a generic nit.

## Known, deliberate things — don't flag these as bugs without reading further

- **`env.js` is committed, not gitignored.** GitHub Pages and Vercel
  serve this repo's files as-is with no build step to inject secrets
  at deploy time, so the real `SUPABASE_URL`/`SUPABASE_ANON_KEY` have
  to live in a loadable file. This is safe: the anon key is meant to
  be public (like a Stripe publishable key) — Row Level Security is
  what actually gates data access, not keeping this file secret. See
  `env.js`'s and `js/core/supabaseConfig.js`'s own doc comments.
- **`EMPLOYEE_PORTAL_EMAIL`/`EMPLOYEE_PORTAL_PASSWORD` in
  `supabaseConfig.js` look like hardcoded credentials.** They are, on
  purpose — see that file's own doc comment. The real per-person check
  is a SQL password hash via `verify_employee_login()`; this shared
  account only exists to satisfy Supabase RLS's "must be
  `authenticated`" requirement and grants no more access than any
  other signed-in session already has (RLS here is table-level, not
  row-level — a separately tracked, understood limitation, see
  `AUTH_GUIDE.md`'s "Security note" section).
- **Sign-up never actually waits on Supabase's "Confirm email"
  toggle.** `supabase/schema.sql`'s `auto_confirm_email()` trigger
  confirms every new `auth.users` row immediately, regardless of the
  dashboard setting — added because the Free tier's email delivery is
  unreliable enough to lock out real accounts with an error
  indistinguishable from a wrong password. If a PR touches sign-up
  flow, this trigger is why "but the toggle is off in the dashboard"
  isn't the whole story.
- **CSV exports force-text-wrap most columns** (`utils/csv.js`'s
  `toCsv`/`escapeCell`, `="value"` formula wrapping) to stop Excel
  from mangling serial numbers/IDs into scientific notation. This is
  intentional, not an escaping bug — only date columns opt out via
  `plainHeaders`.

## Known cleanup already identified, not yet done

- `js/features/auth/UserAccountController.js` and
  `js/features/auth/UserAccountForm.js` are dead code — superseded by
  `js/features/userManagement/UserAccountController.js` /
  `UserAccountForm.js`, which is what `app.js` actually imports.
  Nothing in the repo references the `auth/` copies. Flag a PR that
  edits the `auth/` versions — it's almost certainly meant to touch
  the `userManagement/` ones instead.

## Security boundaries worth knowing

- `service_role` (Supabase) must never appear in client-side code —
  only the `anon` key ships to the browser.
- RLS is currently table-level, not row-level, everywhere. Don't treat
  a PR as introducing a new privilege-escalation bug just because two
  signed-in users can read/write each other's rows — that's the
  existing, documented baseline (see `AUTH_GUIDE.md`), not something
  this PR broke, unless the PR is specifically about access control.
