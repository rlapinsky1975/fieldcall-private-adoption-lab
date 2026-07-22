# Shadow Mode lifecycle update

Apply `supabase/migrations/20260722_shadow_mode_lifecycle.sql` before deploying this build.

Behavior:
- The account Shadow Mode toggle is the default for new assessments.
- Each new job permanently stores whether Shadow Mode was enabled.
- An optional pre-FieldCall contractor read is saved once and locked.
- The assessment page shows the recorded read as read-only; it cannot be changed.
- Outcome capture appears on the assessment as soon as a final FieldCall exists.
- A saved outcome becomes a read-only outcome summary.
- Shadow jobs with no outcome stay in Calls to Review instead of moving to History.
- Non-Shadow jobs keep the normal FieldCall workflow.
