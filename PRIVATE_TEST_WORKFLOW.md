# Private Test User Workflow

## 1. Entry and account

The existing FieldCall entry paths remain intact:

- Existing user login
- Create company
- Join company
- Forgot/reset password
- Guest assessment handoff from the landing page

The private build is clearly labeled so a tester knows it is not the public beta.

## 2. Activation

The dashboard gives the user one finish line:

1. Save one real job.
2. Review and confirm the company's decision posture.
3. Turn on final-call alerts.

When all three are complete, the app confirms that FieldCall is monitoring the first job. The checklist then collapses to a quiet completed state.

## 3. Shadow Mode

Shadow Mode is enabled by default for the private test and can be turned off by the user.

Before running an assessment, the contractor can record the current personal read:

- `GO`
- `DELAY`
- `NO GO`

This input is optional. FieldCall does not show its assessment first, so the comparison is not contaminated by the product's recommendation.

## 4. Assessment and monitoring

The current weather and scoring flow is unchanged:

- Location selection
- Project name and work date
- Service and day/night window
- Final-call time
- Paving setup when applicable
- NWS and Open-Meteo collection
- Service-specific backend scoring
- Company decision posture
- Preliminary or final result
- Communication templates

Every update written to `jobs.last_result` automatically creates a private monitoring event. This includes:

- New preliminary assessments
- Manual saved-job checks
- Automatic final calls prepared by the worker
- A signal, score, reason, or workable-window change

The result screen shows the latest five points in chronological context.

## 5. Contractor-owned final decision

On every saved result, FieldCall separates two records:

- **FieldCall assessment** — the structured framework output
- **My Final Call** — the responsible contractor's decision

The contractor chooses `GO`, `DELAY`, or `NO GO` and can add local context such as site moisture, drainage, haul distance, plant availability, crew capacity, or client restrictions.

The contractor can disagree with FieldCall without being treated as wrong. That disagreement is part of the learning record.

## 6. Communication

The existing client, crew, vendor, and internal communication templates remain available. The contractor can edit, copy, and personalize them.

This keeps the workflow moving from assessment to action instead of ending at a weather score.

## 7. Outcome capture

After the job's work window has passed, the result screen asks:

1. Did the company work, delay, or cancel?
2. Did weather materially affect the work?
3. Did FieldCall help make or communicate the call?
4. What important factor did FieldCall not know? (optional)

This replaces a vague good-call/bad-call rating with useful operational evidence. The existing thumbs-up/down field remains untouched for backward compatibility.

## 8. FieldCall Record

The dashboard converts invisible value into a personal record:

- Jobs monitored
- Calls that materially changed
- Contractor final calls recorded
- Completed-job outcomes captured

It deliberately avoids an unsupported accuracy percentage or automatic savings claim.

## 9. Trust Center

The methodology screen explains:

- What FieldCall does
- What it cannot see
- Why a call may change
- Who owns the final decision
- How the contractor's own proof is built

The tone remains plainspoken: not magic, not a guarantee, and not a replacement for judgment.

## 10. Recommended five-job test

For each real job:

1. Enter the job before weather pressure begins.
2. Record the initial personal read in Shadow Mode.
3. Let FieldCall monitor through the selected final-call time.
4. Record the contractor's actual final call.
5. After the work window, record the outcome.

After five jobs, evaluate whether FieldCall reduced repeated checking, improved consistency, or made communication easier. That is a stronger early signal than asking whether the product predicted every weather event perfectly.
