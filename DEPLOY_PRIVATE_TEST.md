# Deploying to a Separate Private Test Link

## Recommended structure

Create a new Vercel project from this folder or from a separate repository/branch. Use a distinct hostname such as a private test subdomain. Keep the existing public beta project and domain unchanged.

## Build settings

- Framework preset: `Vite`
- Install command: `npm ci`
- Build command: `npm run build`
- Output directory: `dist`

These settings are also enforced by the included `vercel.json`. Do not set the
output directory to the project root or deploy `index.html` as a static file;
the deployed HTML must reference compiled `/assets/` files, not `/src/main.jsx`.

## Environment variables

Copy these values from the current beta project:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_GEOAPIFY_API_KEY`
- `VITE_VAPID_PUBLIC_KEY`

Do not place service-role keys, weather-provider secrets, or private VAPID keys in the frontend project.

## Supabase setup

Run this file once in the existing FieldCall Supabase project:

```text
supabase/migrations/20260721_private_adoption_lab.sql
```

The migration is additive. It creates four private-test tables, row-level security policies, indexes, and one trigger that records monitoring history when a job result changes.

## Authentication settings

Add the separate test origin to the allowed Supabase Auth redirect URLs. The existing reset-password callback uses the current app origin, so no source edit is required.

## Push notifications

The current service worker and VAPID public key are retained. Push subscriptions are origin-specific, so turn alerts on once from the separate test link even if they were already enabled on the public beta.

## First verification

1. Log in with an existing beta account.
2. Confirm the activation checklist loads without an error.
3. Review and confirm the company decision posture.
4. Enable final-call alerts for the new origin.
5. Create a real saved job with a Shadow Mode decision.
6. Confirm the result shows `My Final Call` and monitoring history.
7. Recheck the job and confirm a second timeline event appears.
8. After the work window passes, submit the outcome.

If the normal assessment app loads but the private cards show a missing-table error, the frontend deployment is working and the SQL migration still needs to be applied.
