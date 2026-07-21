# FieldCall Private Adoption Lab

This is a separate test lane built from the July 20 FieldCall beta source. It keeps the existing authentication, company settings, service-specific scoring, saved jobs, automatic final calls, notifications, bilingual UI, and communication templates, then adds the trust and adoption workflow discussed on July 21.

The public beta does not need to be replaced to test this version.

## What is new

- Three-step activation finish line
- Shadow Mode: contractor records a read before seeing FieldCall
- Explicit `Your Decision`: `GO`, `DELAY`, or `NO GO`
- Optional local context attached to the contractor decision
- Automatic monitoring timeline for every change to `jobs.last_result`
- Outcome capture after the work window has passed
- Personal FieldCall Record based on the user's own jobs
- In-app methodology and limitations screen
- Private-test labeling throughout the dashboard
- English and Spanish copy for every new user-facing feature

## Local setup

1. Copy `.env.example` to `.env.local` and use the same environment values as the current beta.
2. Apply `supabase/migrations/20260721_private_adoption_lab.sql` in the Supabase SQL editor.
3. Run:

```bash
npm ci
npm run dev
```

4. Open the local URL printed by Vite.

The component-only design preview is available in development at:

```text
/?private-preview=1
```

## Production build

```bash
npm run build
```

Deploy this folder as a separate Vite project. Copy the four existing FieldCall environment variables into that project. Do not point the public beta domain to this build.

## Safe rollout order

1. Apply the additive SQL migration.
2. Deploy this source to a separate private URL.
3. Sign in with an existing beta account.
4. Run five real jobs in Shadow Mode.
5. Record final decisions and completed-job outcomes.
6. Review the FieldCall Record and monitoring timelines before considering any public release.

The migration does not alter the scoring RPC, existing job columns, assessment history, notification worker, or current landing-to-guest handoff.
