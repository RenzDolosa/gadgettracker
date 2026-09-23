# Adding Supabase Auth: login UI

## Does Supabase give you a login screen?

Not for this app, no. What Supabase provides is an **Auth API**
(`supabase.auth.signInWithPassword`, `.signUp`, `.signOut`, session
management, magic links, OAuth, etc.) plus, separately, a **prebuilt UI
component** called `@supabase/auth-ui-react`. That component is a React
component — this project is plain `<script type="module">` JS with no
bundler and no React, so pulling in a React-only widget would mean adding
a whole framework + build step just to render a login form, which is a bad
trade for one screen.

So: I built a small custom login/sign-up screen (`#authScreen` in
`index.html`, `js/features/auth/AuthView.js` + `AuthController.js`) that
calls the Auth API directly and matches the rest of the app's existing
design system (`.field`, `.field-error`, `.btn-accent`, the same CSS
variables) — the same pattern this app already uses for every other form
(compare to `UserAccountForm.js`).

## What was added

- `js/core/Auth.js` — thin wrapper around `supabase.auth` (sign in, sign
  up, sign out, session, auth-state-change subscription).
- `js/features/auth/AuthView.js` — the login/sign-up screen's DOM
  (tab toggle, fields, error/notice display).
- `js/features/auth/AuthController.js` — the gatekeeper: checks for an
  existing session on load, shows the login screen if there isn't one,
  handles form submits, and only then hands off to the rest of the app.
- `index.html` — `#authScreen` markup, `.shell` now starts `hidden` and is
  only revealed once signed in, sign-out button in the top bar.
- `css/auth.css` — styling for the login screen.
- `js/app.js` — `main()` renamed to `startApp()`, now only called by
  `AuthController.onSignedIn`; a new `bootstrap()` wires up
  `AuthController` and is what actually runs on `DOMContentLoaded`.
- `supabase/schema.sql` — RLS policies tightened from "anon + authenticated"
  to **authenticated only**, now that real sign-in exists.

## How it behaves

1. Page loads → `bootstrap()` → `AuthController.init()` checks for an
   existing Supabase session.
2. **No session** → login screen shows. Person signs in or creates an
   account.
   - Sign-up always completes immediately, regardless of your project's
     Auth setting (Authentication → Providers → Email → "Confirm email"
     toggle in the Supabase dashboard). `supabase/schema.sql`'s
     `auto_confirm_email()` trigger marks every new `auth.users` row
     confirmed the instant it's created, so that dashboard toggle no
     longer has any effect here — added because the Free tier's email
     sender is unreliable enough to leave a real, correctly-linked
     account permanently unable to sign in, with an error
     indistinguishable on screen from a typo'd password (see that
     trigger's own comment in `schema.sql` for the full reasoning).
3. **Session confirmed** → login screen hides, app shell (`#appShell`)
   is revealed, `startApp()` runs (builds all 6 stores, all controllers,
   tabs — exactly what used to run unconditionally).
4. Sign-out button in the top bar calls `supabase.auth.signOut()`, which
   fires the same auth-state listener → login screen shows again, and the
   page does a full reload the next time someone signs in (simplest way to
   give every feature a clean slate — there's no teardown path for
   realtime subscriptions / event listeners otherwise).

## Setting it up in your Supabase project

1. Dashboard → Authentication → Providers → make sure **Email** is enabled
   (it is by default on a new project).
2. The **"Confirm email"** toggle on that same screen doesn't need a
   decision either way — `schema.sql`'s `auto_confirm_email()` trigger
   (see "How it behaves" above) bypasses it regardless of how it's set.
3. Re-run `supabase/schema.sql` (or just the RLS section at the bottom) so
   policies require `authenticated` instead of `anon`.
4. Create your first account through the app's own "Create account" tab —
   no separate admin step needed.
5. **Once your team's accounts exist**, go back to Authentication →
   Providers → Email and turn **off** "Allow new users to sign up" (the
   exact label may vary by dashboard version). This stops randoms from
   self-registering into your data while leaving sign-in open — the app's
   sign-up tab will just show an error if someone tries afterward.

## `user_accounts` is now linked to Supabase Auth

Settings → User management → User used to be a wholly separate,
hand-maintained directory with no relationship to who could actually sign
in. `supabase/schema.sql` now adds an `"authUserId"` column plus two
triggers on `auth.users`:

- **On sign-up**, a `user_accounts` row is created automatically —
  username from the sign-up screen (stored as auth user metadata, not its
  own column), login account/mail from the email, `authUserId` pointing
  back to the real account. The schema's own backfill query links anyone
  who signed up before this trigger existed.
- **On sign-in**, the linked row's `"lastLoginAt"` is kept in sync with
  Supabase Auth's own record — that column existed in the UI before but
  nothing ever populated it.

### "+ Add user" now creates a real sign-in, with one exception

"+ Add user" requires a password and calls `Auth.js`'s
`adminCreateAccount()` — a real `supabase.auth.signUp()`, just run on a
second, throwaway Supabase client (`persistSession: false`,
`autoRefreshToken: false`) so it doesn't hijack the admin's own session
the way calling `signUp()` on the shared client would. The `authUserId`
trigger above then creates (or, if a directory-only row for that email
already existed, claims) the `user_accounts` row automatically; the
modal's follow-up `update()` fills in the fields the trigger doesn't know
about (group, phone, contact mail, enabled state).

Editing an existing **unlinked** row offers the same password fields,
optionally — filling them in "claims" that row into a real account
without recreating it. Editing an **already-linked** row never shows a
raw password field: there's no client-safe way to set someone else's
*existing* password (only the service-role key can, and it must never
ship to the browser). Instead there's a "Send password reset email"
button, using `sendPasswordReset()` /
`supabase.auth.resetPasswordForEmail()`. When the person clicks the
emailed link, they land back in the app already signed in via a
recovery session — Settings → General → Change password
(`updatePassword()`) is what actually sets the new one; no separate
"set new password" screen was needed.

### User management's "Enable" toggle now actually gates login

Before this, disabling a `user_accounts` row didn't do anything to that
person's real ability to sign in — it was a cosmetic checkbox in an
unrelated table. `AuthController._handleSessionChange()` (the one choke
point every session — fresh sign-in, restored session on page load,
token refresh, password recovery — already passed through) now calls
`Auth.js`'s `isAccountEnabled()` first. If it comes back `false`, the
person is immediately signed back out with an explanatory message
instead of reaching the app.

This is deliberately **fail-open**: `isAccountEnabled()` only returns
`false` when a *linked* `user_accounts` row exists and its `enabled`
column is explicitly `false`. No linked row at all — because the
schema.sql migration hasn't been run against this project yet, or a
brand-new sign-up the trigger hasn't caught up on — is treated as
allowed, not blocked. The alternative (treating "no row" as "blocked")
would lock every existing account out the moment this shipped, until
the migration and its backfill had actually been run.

**If you're seeing "0 users" in Settings → User management → User**
despite already having signed-in accounts (as in the screenshot this
was built from), that's this exact situation: the `authUserId` trigger
and backfill from `supabase/schema.sql` haven't been run against your
Supabase project yet. Run the whole file in your project's SQL Editor —
it's idempotent (every `create`/`alter` uses `if not exists`, functions
use `create or replace`, triggers are dropped and recreated) — and the
backfill query will link your existing accounts, including the one
you're currently signed in as.

## Employee login

"Login as Employee" (`AuthView`'s other tab) is a separate path from
everything above — it's for staff who need to be in `user_accounts`
(so they show up in the grid, get logged, etc.) without getting a real
`auth.users` account each, and without anyone's login attempts counting
against Supabase Auth's per-project email rate limit.

It's a two-step check, both in `js/core/Auth.js`:

1. **`verifyEmployeeLogin(loginAccount, password)`** calls
   `supabase/schema.sql`'s `verify_employee_login()` RPC, which checks the
   password against `employee_credentials.passwordHash` (hashed with
   Postgres's own `pgcrypto`, via `set_employee_password()` — never sent
   to or computed by the browser). This is the *real* per-person check.
2. **`signInToEmployeePortal()`** then signs the browser into one shared,
   low-privilege Supabase Auth account — purely so Row Level Security
   sees a valid `authenticated` session. It does **not** re-verify
   anything; step 1 already did the real check. `EmployeeSession` keeps
   track of which actual person is signed in so the rest of the app shows
   and logs the real name, not this shared account.

### One-time setup this needs (not automatic)

`js/core/supabaseConfig.js` ships with:

```js
export const EMPLOYEE_PORTAL_EMAIL = 'employee-portal@internal.stockroom.local';
export const EMPLOYEE_PORTAL_PASSWORD = 'CHANGE-ME-employee-portal-service-password';
```

The email is hardcoded to match `schema.sql`'s `admin_account_exists()`
(which explicitly excludes it), but the **password is a placeholder that
has to be replaced by hand** — there's no automatic way to provision it,
since it's a real Supabase Auth account. Until this is done, "Login as
Employee" fails after the real password check already succeeded, with
"Sign-in succeeded but the app could not connect" (check the browser
console — `Auth.js` logs the specific reason there even though the
on-screen message stays generic).

To set it up:

1. Supabase dashboard → Authentication → Users → **Add user**, using the
   exact email above and any password (nobody ever types it by hand — the
   employee login screen never touches this account directly).
2. Copy that same password into `EMPLOYEE_PORTAL_PASSWORD` in
   `js/core/supabaseConfig.js`.
3. If you ever change `EMPLOYEE_PORTAL_EMAIL`, update the matching literal
   in `schema.sql`'s `admin_account_exists()` too — they have to agree.

**Security note worth understanding, not just working around:** this
password ships to every browser that loads the app — anyone who opens
DevTools → Sources can read it straight out of `supabaseConfig.js`, the
same way they could read any other client-side JS. Combined with RLS
still being table-level rather than row-level (see below), that means
anyone with this password — which is to say, anyone at all — can sign
into the shared portal account directly and get full read/write access
to every table, without ever going through `verify_employee_login()`.
The employee-login check is real screening for the app's own UI, but
it is **not currently a hard security boundary at the database level**.
That's fine for a trusted internal tool where the real gate is "who
can reach this page at all," but if this app becomes internet-facing
or holds anything sensitive, this needs a real fix — most likely
row-level RLS policies keyed off something other than "signed in at
all," rather than a shared account. Worth flagging to whoever owns
that decision before this goes further than an internal warehouse tool.

## Deleting a user's Supabase Auth account

Settings → User management → User's Delete action used to only remove
the `user_accounts` directory row — the person's actual Supabase Auth
sign-in (Authentication → Users in the dashboard) stayed behind, so
they could still log in, just without appearing in this list. Deleting
that normally requires the service-role key, which can't live in
browser code — but `auth.users` is a real Postgres table, and deleting
a row from it directly is a documented, supported approach (it cascades
to `auth.identities`/`sessions`/`refresh_tokens` as needed). So this
goes through a `SECURITY DEFINER` Postgres function instead of an Edge
Function: `supabase/schema.sql`'s `admin_delete_auth_user()`, near the
bottom of the file. Run the SQL Editor paste like everything else in
this project's setup — no Supabase CLI, no separate deploy step.

The function itself refuses to delete the caller's own account (checked
against `auth.uid()`), so nobody can accidentally lock themselves out
through this path — `UserAccountController.js` also checks this
client-side first, for a faster error without a round trip, but the
database is what actually enforces it.

If deletion ever fails, `core/Auth.js`'s `deleteAuthUser()` surfaces
whatever the RPC call fails with, and the directory row is deliberately
left in place rather than being removed anyway, so nothing ends up
orphaned (a person who can still sign in but has vanished from the list).

Employees never reach this path — they have no Supabase Auth account of
their own to delete (see the "Employee login" section above); deleting
their `user_accounts` row is already the complete removal for them,
`employee_credentials` cascades with it.

One thing intentionally left alone rather than assumed:

- **RLS is still table-level, not row-level.** Every signed-in account can
  read/write every row in every table. `UserGroup.permissions` (the
  Allow/Not-allow tree under Settings → User group) still only hides menu
  items in the UI — it isn't enforced server-side. Worth doing once more
  than one trust level of account exists, not before.
