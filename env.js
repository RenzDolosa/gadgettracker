/**
 * Runtime environment config — this project's ".env" equivalent.
 *
 * There's no bundler here (see js/core/supabaseClient.js's own doc
 * comment: everything is plain <script type="module"> against local
 * files, no package.json/build step for the app itself) — which means a
 * real Node-style .env file can't be read by the browser at all; nothing
 * ever runs to substitute its values into the shipped JS. This file is
 * the equivalent that actually works for a plain static site: a plain
 * (non-module) script, loaded by index.html BEFORE js/app.js's module
 * script tag, that sets a global object js/core/supabaseConfig.js reads
 * from at import time.
 *
 * This file is committed, not gitignored (see .gitignore) — this
 * project's static hosts (GitHub Pages, Vercel) serve files as-is with
 * no build step to inject secrets at deploy time, so the real
 * SUPABASE_URL/ANON_KEY have to live in a plain, loadable file for the
 * deployed site to work at all. That's fine: the anon key is meant to
 * be public (see supabaseConfig.js's own doc comment) — Row Level
 * Security is what actually gates data access, not keeping this file
 * secret. Copy env.example.js to env.js (this file) and fill in your
 * own project's values; see that file for where to find them.
 */
window.__ENV__ = {
  SUPABASE_URL: 'https://ttoaqikahjckvukiohle.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR0b2FxaWthaGpja3Z1a2lvaGxlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM5MDE5NTUsImV4cCI6MjA5OTQ3Nzk1NX0.UdmKjc2ctsOoICn7w7uUatkXUuza3aQTP-GHHXBm0_I'
};
