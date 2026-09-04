-- ============================================================================
-- Stockroom / Gadget tracker — Supabase schema
-- ----------------------------------------------------------------------------
-- Run this in: Supabase dashboard → SQL Editor → New query → paste → Run.
--
-- Design decisions (read before running):
--
-- 1. IDs stay TEXT, not UUID. The app already generates ids client-side
--    (see js/utils/id.js: "gadget-abc123xyz") before a record exists on the
--    server, and controllers use the id synchronously the moment
--    store.create() returns (e.g. SettingsController.js binding a freshly
--    created warehouse's id to a new location). Switching to server-generated
--    UUIDs would break that synchronous pattern across ~6 call sites.
--
-- 2. Column names stay camelCase, double-quoted, to match the JS models
--    field-for-field ("createdAt", "warehouseAssetTag", etc.). Postgres
--    lowercases unquoted identifiers, so every camelCase / reserved-word
--    column below is quoted. This means zero renaming/mapping code needed
--    between the JS objects and Supabase rows.
--
-- 3. Timestamps stay BIGINT epoch-ms (Date.now()), not timestamptz — the
--    app's whole formatting layer (js/utils/format.js) and history log
--    entries already work in epoch-ms. Converting to timestamptz would
--    ripple through fmtDate/fmtLocalDateTime and every history entry.
--
-- 4. history / permissions stay JSONB — same shape as the in-memory arrays
--    /objects today, so LogModal and UserGroup's permission tree need no
--    changes.
--
-- 5. RLS is enabled on every table, requiring the `authenticated` role —
--    i.e. a real signed-in Supabase Auth session (see js/features/auth/
--    AuthController.js and AUTH_GUIDE.md). Anonymous requests are rejected
--    outright. Every signed-in account can read/write every row for now;
--    see the policy comment below for how to narrow that further.
--
-- 6. user_accounts is linked to auth.users via an "authUserId" column plus
--    two triggers (see the "user_accounts ↔ auth.users linkage" section
--    below): one auto-creates a user_accounts row the moment someone
--    signs up, the other keeps "lastLoginAt" fed from real sign-ins. Rows
--    added by hand via "+ Add user" stay unlinked (authUserId null) since
--    the client can't create a real Supabase Auth account for someone —
--    only their own sign-up can do that.
-- ============================================================================

-- Needed for gen_random_uuid() if you ever want it; harmless if already enabled.
-- Installed explicitly into `extensions` (Supabase's convention for
-- extensions, not `public`) — every SECURITY DEFINER function below that
-- calls crypt()/gen_salt() schema-qualifies the call AND lists `extensions`
-- in its own search_path, so this works regardless of whether pgcrypto was
-- already sitting in `public` or `extensions` from an earlier partial run.
create extension if not exists pgcrypto with schema extensions;

-- ----------------------------------------------------------------------------
-- warehouses  (Settings → Warehouse Information)
-- ----------------------------------------------------------------------------
create table if not exists public.warehouses (
  id                text primary key,
  "warehouseCode"   text,
  name              text not null,
  "operationMode"   text default 'self-operate',
  "shortName"       text default '',
  currency          text default 'PHP',
  country           text default 'Philippines',
  region            text default '',
  city              text default '',
  barangay          text default '',
  "fullAddress"     text default '',
  "contactPerson"   text default '',
  "publicHomePage"  boolean default true,
  "phoneNumber"     text default '',
  email             text default '',
  "zipCode"         text default '',
  "areaPriority"    text default '',
  "createdAt"       bigint not null,
  "updatedAt"       bigint not null
);

-- ----------------------------------------------------------------------------
-- warehouse_locations  (Settings → Warehouse Information → per-zone positions)
-- ----------------------------------------------------------------------------
create table if not exists public.warehouse_locations (
  id                text primary key,
  "warehouseId"     text references public.warehouses(id) on delete cascade,
  zone              text default 'main',
  area              text default '',
  "row"             text default '',
  "column"          text default '',
  layer             text default '',
  cell              text default '',
  "locationCode"    text default '',
  "positionNumber"  text default '',
  length            text default '',
  width             text default '',
  height            text default '',
  property          text default 'goods',
  enabled           boolean default true,
  "isDefaultStockRoom" boolean default false,
  "createdAt"       bigint not null
);

create index if not exists warehouse_locations_warehouse_idx on public.warehouse_locations ("warehouseId");

-- ----------------------------------------------------------------------------
-- gadgets  (Manage tab — assigned equipment)
-- ----------------------------------------------------------------------------
create table if not exists public.gadgets (
  id                    text primary key,
  "user"                text default '',
  role                  text default '',
  category              text default 'Uncategorized',
  "serialNumber"        text default '',
  "warehouseAssetTag"   text default '',
  "assetTagDefault"     text default '',
  "macAddress"          text default '',
  password              text default '',
  merchant              text default '',
  owner                 text default '',
  remarks               text default '',
  description           text default '',
  "positionType"        text default '',
  warehouse             text default '',
  "temporaryPosition"   text default '',
  "createdAt"           bigint not null,
  "updatedAt"           bigint not null,
  history               jsonb default '[]'::jsonb
);

create index if not exists gadgets_serial_idx on public.gadgets ("serialNumber");

-- ----------------------------------------------------------------------------
-- inventory_assets  (Inventory Assets tab — raw stock, unassigned)
-- ----------------------------------------------------------------------------
create table if not exists public.inventory_assets (
  id              text primary key,
  category        text default '',
  "serialNumber"  text default '',
  "assetTag"      text default '',
  "macAddress"    text default '',
  imei1           text default '',
  imei2           text default '',
  "createdAt"     bigint not null
);

create index if not exists inventory_assets_serial_idx on public.inventory_assets ("serialNumber");

-- Added after inventory_assets already existed live — see gadgets'
-- "createdAt"/"updatedAt"/history columns above for the pattern this
-- mirrors: history is field-change-only (see js/models/InventoryAsset.js's
-- addLogEntry), never logging plain creation the way Gadget's does, so
-- "Added to inventory" isn't sitting in every asset's log as its first,
-- redundant entry. Backfill sets updatedAt = createdAt for rows that
-- predate this column, so it's never null going forward without needing
-- a NOT NULL constraint that would reject an app write that somehow
-- omitted it.
alter table public.inventory_assets add column if not exists "updatedAt" bigint;
alter table public.inventory_assets add column if not exists history jsonb default '[]'::jsonb;
update public.inventory_assets set "updatedAt" = "createdAt" where "updatedAt" is null;

-- A real foreign key from gadgets to its Inventory Assets catalog match,
-- alongside (not instead of) ManageController's existing text-matching
-- validation (_catalogIssues) — that logic still runs at save time and
-- still allows a gadget with no catalog match to exist (hence `on delete
-- set null` below, not `not null`); this column is what makes the
-- relationship a real one Postgres knows about too, not just something
-- re-derived by string comparison on every render. Placed here (after
-- inventory_assets exists), not inline in the gadgets table above,
-- because it references this table — `add column if not exists` is what
-- actually lands it on the *existing* live database; a fresh install
-- just gets it in one pass same as any other column.
alter table public.gadgets add column if not exists "inventoryAssetId" text references public.inventory_assets(id) on delete set null;
create index if not exists gadgets_inventory_asset_id_idx on public.gadgets ("inventoryAssetId");

-- One-time backfill for rows that predate this column: link any existing
-- gadget to its catalog match by the same rule the app already applies
-- (exact, trimmed serial number match). Safe to re-run — only touches
-- rows whose link is missing or out of date.
update public.gadgets g
set "inventoryAssetId" = ia.id
from public.inventory_assets ia
where trim(g."serialNumber") <> ''
  and trim(g."serialNumber") = trim(ia."serialNumber")
  and g."inventoryAssetId" is distinct from ia.id;

-- ----------------------------------------------------------------------------
-- requisitions  (Requisition Form tab — in-app clone of the reference
-- "Operation Gadget Request Form" Google Form; see js/models/Requisition.js)
-- ----------------------------------------------------------------------------
create table if not exists public.requisitions (
  id               text primary key,
  email            text default '',
  "requesterName"  text default '',
  -- [{ category: 'KAICOM', qty: 12 }, ...] — one row per Gadget Type
  -- selected in the form's own "+ Add row" pattern; see the reference
  -- FORM vs Print Preview screenshots this feature was built from.
  items            jsonb default '[]'::jsonb,
  purpose          text default '',
  "submittedBy"    text default '',
  "createdAt"      bigint not null,
  status           text default 'pending',
  -- Gadget ids actually issued by "Process request" (see
  -- RequisitionController._processRequest) — see
  -- models/Requisition.js's own fulfilledGadgetIds doc.
  "fulfilledGadgetIds" jsonb default '[]'::jsonb,
  -- One snapshot per row actually issued (matched Gadget or hand-typed)
  -- — see models/Requisition.js's own fulfilledItems doc.
  "fulfilledItems" jsonb default '[]'::jsonb
);

-- ----------------------------------------------------------------------------
-- Receiving / pending transfers (Task 1)
-- ----------------------------------------------------------------------------
-- A merchant transfer requested on an existing asset, when it resolves to
-- a real created location, doesn't take effect immediately — it's
-- stashed here until someone whose User Group is bound to the
-- destination warehouse (user_groups."boundWarehouseIds" — the same
-- scoping that already governs what a group sees elsewhere in Manage/
-- Reports, see core/WarehouseScope.js) — or anyone with the
-- manage.confirm-transfers permission — confirms it via
-- ManageController.confirmTransfer(). See models/Gadget.js's
-- pendingTransfer for the JSON shape (toWarehouseId is the id this
-- checks against boundWarehouseIds).
--
-- This used to instead be gated by a per-location "assigned user"
-- (warehouse_locations."assignedUsername", set one specific username per
-- position) — dropped in favor of boundWarehouseIds so "who can act on
-- this" follows the exact same group-based scoping as everywhere else in
-- the app, rather than a second, separate assignment mechanism to keep
-- in sync. If you're upgrading an existing database, this column and
-- its data are gone after running this — reassign access via each User
-- Group's "Bind warehouse" list (Settings → User management → User
-- group) instead.
alter table public.gadgets add column if not exists "pendingTransfer" jsonb;
alter table public.warehouse_locations drop column if exists "assignedUsername";

-- Stock Room default — WarehouseLocationModal's "Stock Room" column lets
-- one location per warehouse (across all its zones) be flagged as the
-- default; see models/WarehouseLocation.js's isDefaultStockRoom doc.
alter table public.warehouse_locations add column if not exists "isDefaultStockRoom" boolean default false;

-- Recent Requisitions' own Action menu (Finish/Reopen/Delete) — see
-- models/Requisition.js's status doc.
alter table public.requisitions add column if not exists status text default 'pending';

-- "Process request" (see RequisitionController._processRequest) records
-- which gadgets it actually issued here — this column was missing from
-- every already-created requisitions table, which broke not just
-- "Process request" but *every* new requisition Submit: the Requisition
-- model has always included fulfilledGadgetIds (defaulting to []) on
-- every instance, so every insert sent a column Postgres didn't
-- recognize and rejected the whole row — see
-- models/Requisition.js's own fulfilledGadgetIds doc.
alter table public.requisitions add column if not exists "fulfilledGadgetIds" jsonb default '[]'::jsonb;

-- Process Request now records a full snapshot of every row it issues —
-- including hand-typed rows with no matching Gadget id, which
-- "fulfilledGadgetIds" alone can't represent — so "Actually Served"
-- (RequisitionController._openFulfillmentLog) can show the whole
-- document instead of just whichever rows matched a real asset. See
-- models/Requisition.js's own fulfilledItems doc.
alter table public.requisitions add column if not exists "fulfilledItems" jsonb default '[]'::jsonb;

-- ----------------------------------------------------------------------------
-- user_accounts  (Settings → User management → User)
-- ----------------------------------------------------------------------------
create table if not exists public.user_accounts (
  id              text primary key,
  "userNumber"    text,
  username        text not null,
  "loginAccount"  text not null,
  mail            text default '',
  "phoneNumber"   text default '',
  enabled         boolean default true,
  "createdAt"     bigint not null,
  "updatedAt"     bigint not null,
  "lastLoginAt"   bigint,
  history         jsonb default '[]'::jsonb
);

create unique index if not exists user_accounts_login_idx on public.user_accounts (lower("loginAccount"));

-- ----------------------------------------------------------------------------
-- user_accounts ↔ auth.users linkage
-- ----------------------------------------------------------------------------
-- Connects each User-management row to the real Supabase Auth account it
-- can sign in as, if any. This is the follow-on step AUTH_GUIDE.md flagged
-- as not yet done: previously user_accounts was a wholly separate,
-- hand-maintained directory with zero relationship to who could actually
-- log in — this makes signing up (js/features/auth/) and appearing here
-- the same event.
--
-- Rows added by hand via "+ Add user" keep "authUserId" null: there's no
-- real Supabase Auth account behind them (the client can't create one —
-- that needs either the person's own "Create account" sign-up or the
-- service-role key, which must never live in browser code), so they're
-- directory entries only until that email actually signs up.
alter table public.user_accounts add column if not exists "authUserId" uuid references auth.users(id) on delete set null;
create unique index if not exists user_accounts_auth_user_idx on public.user_accounts ("authUserId") where "authUserId" is not null;

-- Every account here — whether from the one-time bootstrap "Set up the
-- account" sign-up or an admin's "+ Add user" → "Link account" (see
-- adminCreateAccount() in js/core/Auth.js) — is created by someone who
-- already has (or is) legitimate access to this internal tool; nobody
-- signs up to it the way they would to a public product. Email
-- confirmation exists to prove "you own this inbox" before trusting a
-- *stranger's* self-service signup, which isn't the threat model here.
--
-- Left ON (the Supabase default), it actively breaks logins on this
-- project's Free tier: the built-in email sender is aggressively rate
-- limited and often just doesn't deliver, so a real, correctly-linked
-- account (user_accounts."authUserId" set, "Linked" badge showing) can
-- sit permanently unable to sign in — GoTrue rejects
-- signInWithPassword() for an unconfirmed user regardless of whether the
-- password was even correct. That's indistinguishable, on screen, from a
-- typo'd password (see AuthController._handleSubmit's deliberately
-- generic "Incorrect email/login account or password" — kept generic on
-- purpose to avoid letting sign-in attempts enumerate which emails have
-- accounts; see that function's own comment) — so the person has no way
-- to tell the two apart or self-recover.
--
-- This trigger removes the gate at the source instead: every new
-- auth.users row is marked confirmed the instant it's created, so
-- signInWithPassword() never has an "unconfirmed" reason to fail here.
-- Confirmation-email delivery becomes a non-issue rather than a
-- recurring support problem. If this project ever adds genuine public
-- self-service signup, revisit this trigger first.
create or replace function public.auto_confirm_email()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.email_confirmed_at is null then
    new.email_confirmed_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_auto_confirm on auth.users;
create trigger on_auth_user_auto_confirm
  before insert on auth.users
  for each row execute function public.auto_confirm_email();

-- This file is the sole owner of what's attached to auth.users — only
-- the three triggers it defines (immediately above, plus
-- on_auth_user_created/on_auth_user_login further below) should ever be
-- there. Sweeps away anything else before the UPDATE just below can fire
-- it: a schema that's had features added and later removed can be left
-- with a trigger from one of those old features still attached to
-- auth.users — e.g. a since-removed "mirror email_confirmed_at onto
-- user_accounts" trigger, whose backing function still updates a
-- user_accounts column that isn't there anymore. Nothing here except
-- signing in ever touches auth.users, so any stray trigger silently
-- sitting on it exists purely to break that UPDATE with an unrelated
-- error the moment it fires — not to preserve behavior anything in this
-- codebase still depends on.
do $$
declare
  t record;
begin
  for t in
    select tgname from pg_trigger
    where tgrelid = 'auth.users'::regclass
      and not tgisinternal
      and tgname not in ('on_auth_user_created', 'on_auth_user_login', 'on_auth_user_auto_confirm')
  loop
    execute format('drop trigger if exists %I on auth.users;', t.tgname);
  end loop;
end $$;

-- One-time backfill: unblocks every account that already got stuck
-- unconfirmed before this trigger existed (this is what actually fixes
-- an already-"Linked" account that still can't sign in today). Safe to
-- re-run — only touches rows that are still unconfirmed.
update auth.users set email_confirmed_at = now() where email_confirmed_at is null;

-- Fires the moment someone signs up (supabase.auth.signUp — see
-- js/core/Auth.js) and creates their user_accounts row automatically,
-- pulling the username they typed on the sign-up screen (stored as auth
-- user_metadata, not its own column — see AuthController.js) and their
-- email. If a directory-only row for that same email already exists
-- (added by hand via "+ Add user" before this person had a real account),
-- that row is linked instead of a new one being created. SECURITY DEFINER
-- because the person signing up has no session yet at the instant this
-- runs, so it must bypass user_accounts' own "authenticated" RLS policy
-- to write at all.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_username text := coalesce(nullif(new.raw_user_meta_data ->> 'username', ''), split_part(new.email, '@', 1));
  v_now bigint := (extract(epoch from new.created_at) * 1000)::bigint;
begin
  -- The employee-portal service account (see "Employee (SQL-only) login"
  -- below) is a real auth.users row, but it isn't a person — it exists
  -- only so employee sign-ins can get a valid `authenticated` session
  -- after verify_employee_login() checks their SQL-stored password. Skip
  -- creating a directory entry for it; the real employee row (keyed by
  -- their own id, not this account's) already exists from "+ Add user".
  if new.email = 'qrpass.3pl+portal@gmail.com' then
    return new;
  end if;

  -- If a directory-only row already exists for this email (added by hand
  -- via "+ Add user" before this person had a real account — see
  -- UserAccountController.js), link it instead of inserting a duplicate.
  -- user_accounts has a unique index on lower("loginAccount"), so a plain
  -- insert here would violate it and abort this whole sign-up.
  update public.user_accounts
  set "authUserId" = new.id, username = v_username, "updatedAt" = v_now
  where lower("loginAccount") = lower(new.email) and "authUserId" is null;

  if not found then
    -- The ON CONFLICT target below must repeat the partial index's WHERE
    -- clause (line ~181) — Postgres won't match a plain "ON CONFLICT
    -- (col)" against a *partial* unique index without it, and errors with
    -- "no unique or exclusion constraint matching the ON CONFLICT
    -- specification" instead. That error surfaced to users as Supabase's
    -- generic "Database error creating new user" on every genuinely-new
    -- sign-up (dashboard or app) — nothing to do with the data being
    -- inserted, purely this clause not matching the index it targets.
    insert into public.user_accounts (
      id, "userNumber", username, "loginAccount", mail, enabled,
      "createdAt", "updatedAt", "authUserId"
    )
    values (
      'usr-' || replace(gen_random_uuid()::text, '-', ''),
      (floor(random() * 89999999) + 10000000)::text,
      v_username,
      new.email,
      new.email,
      true,
      v_now,
      v_now,
      new.id
    )
    on conflict ("authUserId") where "authUserId" is not null do nothing;
  end if;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- Keeps the "Last Login" column (already in the UI, previously always
-- blank — nothing ever set it) fed from Supabase Auth's own record of
-- sign-ins, rather than the app trying to track that itself.
create or replace function public.handle_auth_user_login()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.user_accounts
  set "lastLoginAt" = (extract(epoch from new.last_sign_in_at) * 1000)::bigint
  where "authUserId" = new.id;
  return new;
end;
$$;

drop trigger if exists on_auth_user_login on auth.users;
create trigger on_auth_user_login
  after update of last_sign_in_at on auth.users
  for each row
  when (new.last_sign_in_at is distinct from old.last_sign_in_at)
  execute function public.handle_auth_user_login();

-- One-time backfill: links accounts that signed up before this trigger
-- existed (anyone already using the app, including whoever's running this
-- script). Safe to re-run — on_auth_user_created's own on-conflict guard,
-- plus this query only targeting auth.users with no linked row yet, means
-- nothing gets duplicated on a second run.
insert into public.user_accounts (
  id, "userNumber", username, "loginAccount", mail, enabled, "createdAt", "updatedAt", "lastLoginAt", "authUserId"
)
select
  'usr-' || replace(gen_random_uuid()::text, '-', ''),
  (floor(random() * 89999999) + 10000000)::text,
  coalesce(nullif(au.raw_user_meta_data ->> 'username', ''), split_part(au.email, '@', 1)),
  au.email,
  au.email,
  true,
  (extract(epoch from au.created_at) * 1000)::bigint,
  (extract(epoch from au.created_at) * 1000)::bigint,
  case when au.last_sign_in_at is not null then (extract(epoch from au.last_sign_in_at) * 1000)::bigint end,
  au.id
from auth.users au
left join public.user_accounts ua on ua."authUserId" = au.id
where ua.id is null;

-- ----------------------------------------------------------------------------
-- Employee (SQL-only) login — avoids Supabase Auth's email rate limit
-- ----------------------------------------------------------------------------
-- Problem this solves: every "+ Add user" used to call supabase.auth.signUp()
-- (see the old adminCreateAccount() in js/core/Auth.js), which — even with
-- "Confirm email" off — still counts against Supabase's email-sending rate
-- limit (a few per hour on the default/free SMTP config). Adding more than
-- a handful of staff in one sitting hits that limit fast, and it has
-- nothing to do with how many people actually need real admin-level
-- Supabase Auth accounts.
--
-- Fix: two account tiers, matching the login screen's two tabs.
--   • Administrator — a real Supabase Auth account (auth.users), created
--     only via the login screen's own "Create account" tab (self-service,
--     one email at signup time — see admin_account_exists() below for why
--     that tab disappears after the first one exists). Signs in with
--     supabase.auth.signInWithPassword(); nothing here changes that path.
--   • Employee — a row in user_accounts with a password hashed *in
--     Postgres* (pgcrypto's crypt()/gen_salt()) and stored in the
--     employee_credentials table below. Created by "+ Add user" writing
--     directly to these two tables — no Supabase Auth call, no email, no
--     rate limit, no matter how many get added. verify_employee_login()
--     checks the password; on success the client then signs in to one
--     fixed, shared "employee portal" Supabase Auth account (see
--     AUTH_GUIDE.md's "Employee login" section for the one-time setup
--     step) purely to obtain a valid `authenticated` RLS session — the
--     app tracks *which* employee that really is separately (see
--     js/core/EmployeeSession.js), the same way UserAccount.authUserId
--     already separates "directory row" from "real sign-in".
--
-- employee_credentials is a separate table, not a "passwordHash" column on
-- user_accounts, so that a plain `select * from user_accounts` (which
-- every signed-in account can run, admin or employee — RLS here is
-- table-level, see the policy section below) never has a hash to leak in
-- the first place. This table gets no ordinary RLS policy at all — the
-- only way in or out is through the two SECURITY DEFINER functions below,
-- which bypass RLS as their owner.
create table if not exists public.employee_credentials (
  "userAccountId" text primary key references public.user_accounts(id) on delete cascade,
  "passwordHash"  text not null,
  "updatedAt"     bigint not null
);
alter table public.employee_credentials enable row level security;
-- Deliberately no policies — see the comment above. RLS with zero
-- policies means "no direct access for anyone", by design.

-- Lets the (signed-out) login screen decide whether to show "Create
-- account" at all: per this feature's whole premise, that tab should only
-- ever create the *first* administrator. Runs as anon (grant below), so it
-- can't just query auth.users directly — anon has no access to that
-- schema — hence SECURITY DEFINER. The employee-portal service account
-- itself is excluded, or the very act of setting that account up would
-- permanently hide "Create account" even with zero real administrators.
create or replace function public.admin_account_exists()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from auth.users
    where email <> 'qrpass.3pl+portal@gmail.com'
  );
$$;
grant execute on function public.admin_account_exists() to anon;

-- Verifies an employee's SQL-stored password and returns just enough of
-- their directory row for the client to show who's signed in and stamp
-- history entries — never the hash, never anything from other rows.
-- Returns zero rows on any failure (unknown login, wrong password,
-- disabled account, or no credentials set yet) rather than distinguishing
-- which, same reasoning as Supabase Auth's own generic "Invalid login
-- credentials" — specific failure reasons make account enumeration easier.
-- anon-callable (grant below): this *is* the login step, so it has to work
-- before any session exists.
-- CREATE OR REPLACE can't change a function's return column list, which
-- this one does (userGroup -> userGroupId, as part of the userGroupId
-- foreign-key migration above) — has to be dropped first, or re-running
-- this file errors with "cannot change return type of existing function".
drop function if exists public.verify_employee_login(text, text);
create or replace function public.verify_employee_login(p_login_account text, p_password text)
returns table (id text, username text, "userGroupId" text, mail text)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  return query
  select ua.id, ua.username, ua."userGroupId", ua.mail
  from public.user_accounts ua
  join public.employee_credentials ec on ec."userAccountId" = ua.id
  where lower(ua."loginAccount") = lower(p_login_account)
    and ua.enabled = true
    and ec."passwordHash" = extensions.crypt(p_password, ec."passwordHash");
end;
$$;
grant execute on function public.verify_employee_login(text, text) to anon;

-- Sets (or replaces) an employee's SQL-stored password — what "+ Add
-- user" / the edit modal call instead of the old adminCreateAccount()
-- signUp(). `to authenticated` rather than anon: only someone already
-- signed in (as an administrator or another employee — this app's RLS is
-- table-level, not per-role, same limitation AUTH_GUIDE.md already notes
-- for every other table) can call this. gen_salt('bf') is bcrypt, the
-- same algorithm family Supabase Auth itself uses for auth.users.
create or replace function public.set_employee_password(p_login_account text, p_new_password text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user_id text;
begin
  select id into v_user_id from public.user_accounts where lower("loginAccount") = lower(p_login_account);
  if v_user_id is null then
    raise exception 'No user_accounts row for login account %', p_login_account;
  end if;

  insert into public.employee_credentials ("userAccountId", "passwordHash", "updatedAt")
  values (v_user_id, extensions.crypt(p_new_password, extensions.gen_salt('bf')), (extract(epoch from now()) * 1000)::bigint)
  on conflict ("userAccountId") do update
    set "passwordHash" = excluded."passwordHash", "updatedAt" = excluded."updatedAt";
end;
$$;
grant execute on function public.set_employee_password(text, text) to authenticated;

-- ----------------------------------------------------------------------------
-- user_groups  (Settings → User management → User group)
-- ----------------------------------------------------------------------------
create table if not exists public.user_groups (
  id              text primary key,
  "groupNumber"   text,
  name            text not null,
  enabled         boolean default true,
  permissions     jsonb default '{}'::jsonb,
  "boundWarehouseIds" jsonb default '[]'::jsonb,
  "createdAt"     bigint not null,
  "updatedAt"     bigint not null,
  history         jsonb default '[]'::jsonb
);

create unique index if not exists user_groups_name_idx on public.user_groups (lower(name));

-- Existing deployments that already ran this file before "Bind warehouse"
-- existed won't have this column from `create table if not exists` alone.
alter table public.user_groups add column if not exists "boundWarehouseIds" jsonb default '[]'::jsonb;

-- user_accounts.userGroup used to be a plain free-text name, matched
-- against user_groups.name by string comparison on every permission
-- check and every "Bound user" render — same problem gadgets.
-- inventoryAssetId above already solved for gadgets/inventory_assets:
-- a name match breaks silently the moment a group gets renamed, and
-- can't be indexed or joined properly. This column is what makes the
-- relationship a real one Postgres knows about, same as that one.
--
-- Placed here (after user_groups exists), not inline in the
-- user_accounts table far above, for the same reason inventoryAssetId
-- isn't inline in gadgets — it references this table. `add column if
-- not exists` is what actually lands it on the *existing* live
-- database; a fresh install just gets it in one pass same as any other
-- column.
alter table public.user_accounts add column if not exists "userGroupId" text references public.user_groups(id) on delete set null;
create index if not exists user_accounts_user_group_id_idx on public.user_accounts ("userGroupId");

-- One-time backfill for rows that predate this column: link any existing
-- account to its group by the same rule the app used to apply at read
-- time (trimmed, case-insensitive name match — the unique index above
-- guarantees this is never ambiguous). Safe to re-run, including *after*
-- "userGroup" has already been dropped below (which it will be, on any
-- run past the first) — wrapped in a DO block that checks the column
-- still exists first, since PL/pgSQL only parses/plans a statement
-- inside a branch that actually executes. Without this guard, re-running
-- this file at all fails outright on the second run: "userGroup" is gone
-- by then, and Postgres won't even plan a bare UPDATE referencing a
-- column that doesn't exist, guarded or not.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'user_accounts' and column_name = 'userGroup'
  ) then
    update public.user_accounts ua
    set "userGroupId" = ug.id
    from public.user_groups ug
    where ua."userGroupId" is null
      and ua."userGroup" is not null
      and trim(ua."userGroup") <> ''
      and lower(trim(ug.name)) = lower(trim(ua."userGroup"));
  end if;
end $$;

-- Now redundant — every reader (admin_can/employee_can below,
-- UserGroupController._boundUsernames, UserAccountForm's group picker)
-- uses userGroupId instead. Dropped rather than left alongside it so
-- there's exactly one place a group assignment can live, not two that
-- could quietly disagree.
alter table public.user_accounts drop column if exists "userGroup";

-- ============================================================================
-- Row Level Security
-- ============================================================================
alter table public.warehouses           enable row level security;
alter table public.warehouse_locations  enable row level security;
alter table public.gadgets              enable row level security;
alter table public.inventory_assets     enable row level security;
alter table public.user_accounts        enable row level security;
alter table public.user_groups          enable row level security;
alter table public.requisitions         enable row level security;

-- Now that the app has real Supabase Auth (see js/features/auth/), require
-- a signed-in session for every operation on every table. This replaces an
-- earlier draft of this schema that allowed the `anon` role too — that was
-- only ever a placeholder for "no login exists yet"; now one does.
--
-- This is table-level only: any signed-in account can read/write every
-- row in every table. If you later need per-warehouse or per-role
-- restrictions (enforcing UserGroup.permissions server-side, not just
-- hiding menu items in the UI), tighten the `using`/`with check` clauses
-- below — e.g. `using (auth.uid() = "someOwnerColumn")`.
do $$
declare
  t text;
begin
  foreach t in array array['warehouses','warehouse_locations','gadgets','inventory_assets','user_accounts','user_groups','requisitions']
  loop
    execute format('drop policy if exists "allow_all_anon" on public.%I;', t);
    execute format('drop policy if exists "authenticated_read_write" on public.%I;', t);
    execute format(
      'create policy "authenticated_read_write" on public.%I for all to authenticated using (true) with check (true);',
      t
    );
  end loop;
end $$;

-- ============================================================================
-- Realtime (optional, but recommended for a multi-user warehouse tool so
-- one staff member's changes show up for everyone else without a manual
-- refresh — SupabaseStore.js subscribes to these automatically).
-- ============================================================================
do $$
declare
  t text;
begin
  foreach t in array array['warehouses','warehouse_locations','gadgets','inventory_assets','user_accounts','user_groups','requisitions']
  loop
    begin
      execute format('alter publication supabase_realtime add table public.%I;', t);
    exception when duplicate_object then
      -- already added on a previous run of this script — fine, skip it.
      null;
    end;
  end loop;
end $$;
-- ============================================================================
-- Deleting a linked user's Supabase Auth account — replaces the earlier
-- Edge Function approach (supabase/functions/delete-auth-user), which
-- required a one-time `supabase functions deploy` via the CLI that never
-- got run. auth.users is a real Postgres table, and Supabase's own docs
-- confirm deleting a row from it directly is supported and cascades to
-- auth.identities/sessions/refresh_tokens as needed — so a SECURITY
-- DEFINER function here does the same job with just this SQL paste,
-- no CLI required. See core/Auth.js's deleteAuthUser(), now calling
-- this via supabase.rpc(...) instead of supabase.functions.invoke(...).
-- ============================================================================
create or replace function public.admin_delete_auth_user(target_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if target_user_id = auth.uid() then
    raise exception 'You can''t delete your own account while signed in as it.';
  end if;
  delete from auth.users where id = target_user_id;
end;
$$;

grant execute on function public.admin_delete_auth_user(uuid) to authenticated;
