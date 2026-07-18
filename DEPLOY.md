# Deploying Home Design App

The app is a static Vite/React frontend backed by Supabase (auth + Postgres). There's no separate server to run — Vercel serves the built static files, and the browser talks to Supabase directly.

## 1. Supabase (already done)

You've already created a Supabase project and run `supabase/schema.sql` in the SQL editor. If you ever spin up a second environment (e.g. a separate staging project), repeat that: create the project, run `supabase/schema.sql`, and copy the URL + anon key below.

**Auth settings worth knowing about** (Authentication → Sign In / Providers → Email in the Supabase dashboard):

- **Confirm email** — if left on, every new signup must click a confirmation link before they can sign in, and Supabase's built-in email sender has a low rate limit (fine for occasional use, not for several people signing up in the same hour). Turning it off is the simplest option for a small group of known testers.
- Consider setting a custom SMTP provider later if you outgrow the built-in sender's rate limit (Authentication → Emails → SMTP Settings).

## 2. Push the code to GitHub

Vercel deploys from a Git repository. If this project isn't in one yet:

```bash
git init
git add .
git commit -m "Initial commit"
```

Then create a repo on GitHub and push (via the GitHub CLI `gh repo create`, or create it on github.com and follow the "push an existing repository" instructions it gives you).

## 3. Create the Vercel project

1. Go to [vercel.com](https://vercel.com), sign in (GitHub login is easiest), **Add New → Project**.
2. Import the GitHub repo you just pushed.
3. Vercel auto-detects Vite (there's also a `vercel.json` in the repo pinning the build/output settings explicitly) — you shouldn't need to change build settings.
4. **Before deploying**, add the environment variables (Project Settings → Environment Variables, or the form shown during import):
   - `VITE_SUPABASE_URL` — your Supabase project URL
   - `VITE_SUPABASE_ANON_KEY` — your Supabase anon/publishable key
   
   Add both for all environments (Production, Preview, Development) so preview deploys work too.
5. Deploy. Vercel gives you a `*.vercel.app` URL — that's what you share with friends.

## 4. Verify

- Open the deployed URL, sign up with a real email, confirm you land in the app.
- Draw a wall, save a project ("Save to cloud"), reload the page, sign back in, confirm the project is still there.
- Check the Supabase dashboard (Table Editor → `projects`) to see the row.

## Updating later

Any `git push` to the connected branch triggers a new Vercel deploy automatically — no extra steps needed for future changes.
