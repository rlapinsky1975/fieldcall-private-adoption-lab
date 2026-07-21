# Development Lab — Canonical Hourly Window Release

This development-lab build contains the adoption-preview work plus the canonical hourly scoring update.

Deployment order:

1. Run the Supabase canonical-hourly migration.
2. Run its SQL validation tests.
3. Deploy the updated automatic final-call worker.
4. Deploy this private adoption-lab app.

The private lab remains the recommended place to test this change before promoting the same `App.jsx` changes to the shared beta app.
