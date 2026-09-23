# Migrating this app to Supabase

## What changed, architecturally

Before: 6 entities (Gadget, InventoryAsset, Warehouse, WarehouseLocation,
UserAccount, UserGroup), each backed by `Store.js` — a synchronous
CRUD wrapper around `localStorage`, emitting `'change'` events that every
controller already listens to for re-rendering.

That reactive pattern (mutate → emit `'change'` → controller re-renders) is
exactly what makes this migration tractable without rewriting ~5,000 lines
of controller/view code. `js/core/SupabaseStore.js` is a **drop-in
replacement for `Store.js`** — same public methods (`list`, `get`, `create`,
`update`, `delete`, `clear`), same `'change'` events — but backed by a real
Postgres table over the network instead of the browser's local storage.

How it reconciles "synchronous API" with "network is async":
- `records` is kept as an in-memory cache, same as before.
- Reads (`list`/`get`) are synchronous, straight from that cache — no
  controller code needs `await`.
- Writes (`create`/`update`/`delete`) update the cache and emit `'change'`
  **immediately** (optimistic UI), then fire the Supabase request in the
  background. If it fails, the cache rolls back, another `'change'` fires,
  and an `'error'` event lets `app.js` show a Toast.
- One new step: `await store.init()` once at startup, to do the initial
  fetch. `app.js`'s `main()` is now `async` for exactly this.
- Optional: each store subscribes to Supabase Realtime, so one person's
  edit shows up in everyone else's browser tab automatically.

Nothing in `ManageController.js`, `InventoryAssetController.js`,
`SettingsController.js`, `UserAccountController.js`, `UserGroupController.js`,
`ReportsController.js`, or any view/form file needed to change.

## Setup steps

1. **Create a Supabase project** at supabase.com (if you haven't already).
2. **Run the schema**: Supabase dashboard → SQL Editor → paste the contents
   of `supabase/schema.sql` → Run. This creates all 8 tables (the
   original 6 below, plus `requisitions` and `employee_credentials`
   added later — see "Security: authentication"), RLS policies, and
   adds the tables to the realtime publication.
3. **(Optional) Seed demo data**: same SQL Editor → paste
   `supabase/seed.sql` → Run. Skip this if you want the app to start empty.
4. **Fill in credentials**: copy `env.example.js` → `env.js` (project
   root), then fill in `SUPABASE_URL` and `SUPABASE_ANON_KEY` there, from
   Supabase dashboard → Settings → API. The anon key is safe to ship
   client-side — RLS is what actually gates access (see below). `env.js`
   is committed rather than gitignored in this project, since GitHub
   Pages/Vercel serve it as-is with no build step to inject it
   otherwise — safe to do given the anon key is meant to be public.
5. **Serve the app** the same way you already do (it's still a plain
   `<script type="module">` app, no bundler) and open it. Check the browser
   console: `SupabaseStore` logs an error there if the client isn't
   configured yet.

## Rollout order, if you want to verify incrementally

You don't have to flip all 6 at once. A safe order, smallest/least-connected
first:
1. `warehouses` + `warehouse_locations` (Settings tab) — verify create/edit/
   delete a warehouse and a location, confirm the tree updates.
2. `inventory_assets` (Inventory Assets tab) — simplest CRUD shape, no
   cross-references.
3. `gadgets` (Manage tab) — the biggest controller by far (1,400+ lines
   and still growing), exercises transfer/bulk actions, CSV import,
   merchant-placement derivation.
4. `user_accounts` + `user_groups` (Settings → User management) — verify
   the "bound username" cross-reference between the two still resolves.
5. `requisitions` (Requisition tab, added after this migration doc was
   first written) — verify submit → process → fulfillment log round-trips.

To do this incrementally, just leave the stores you haven't migrated yet as
`new Store({...})` (old localStorage) in `app.js` and only swap one
`new SupabaseStore({...})` at a time.

## Security: authentication

**Update:** real Supabase Auth (email/password sign-in and sign-up) has
since been added — see `AUTH_GUIDE.md` for what was built, how it behaves,
and the remaining hardening steps (disabling public self-signup once your
team's accounts exist, and optionally linking `user_accounts` rows to real
`auth.users`). `supabase/schema.sql`'s RLS policies now require an
authenticated session rather than allowing anonymous access.

## Files in this migration

- `js/core/SupabaseStore.js` — the new store adapter (see above).
- `js/app.js` — swapped `Store` → `SupabaseStore` for all 6 entities, `main()`
  renamed to `startApp()` and now gated behind sign-in (see AUTH_GUIDE.md).
- `supabase/schema.sql` — table definitions, RLS, realtime publication.
- `supabase/seed.sql` — optional, mirrors the old in-browser demo data.
- `js/core/supabaseClient.js` / `supabaseConfig.js` — unchanged; these were
  already scaffolded in the project, just unused until now.
- `js/core/Auth.js`, `js/features/auth/*`, `css/auth.css` — login/sign-up
  screen and auth gate. See `AUTH_GUIDE.md` for details.
