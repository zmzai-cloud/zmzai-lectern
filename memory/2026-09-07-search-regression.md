# Cross-project search regression

- Symptom: more than 30 results across projects; one unavailable database fails the entire request.
- Root cause: result limit only exits the session loop; eager database opening and list reads have no project-level error boundary.
- Fix: lazily open each project, isolate database opening/list failures, stop the outer loop at 30 results.
- Evidence: three failing route tests reproduced both issues before the fix. All five route tests now pass; full suite 98 passed, typecheck and diff check passed.
- Regression test: `lib/session-search-route.test.ts` mocks project stores but executes the actual Next route and response serialization.
- Related: cross-project search was recently wired without route-level tests. Build success did not cover these behaviors.
- Status: DONE for these regressions. Full search workflow, real database and browser validation remain incomplete.
