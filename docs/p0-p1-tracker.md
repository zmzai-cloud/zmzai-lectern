# Lectern P0 / P1 Delivery Tracker

Scope: the complete P0 and P1 list requested after 0.5.0. Existing code is not
proof of completion: every item needs behavioral evidence. No item is removed
because it requires credentials, hardware, or framework changes.

## Design and Sequence

Keep the approved 0.5.0 visual language. Extend existing settings, task sidebar,
workbench and delivery APIs rather than introduce a second application shell.
Implement in three batches: release safety, task/message workflows, then delivery
and agent configuration. An all-at-once rewrite has excessive regression risk;
UI-only work would leave the P0 safety issues unresolved.

Release gates must fail closed, run on macOS and Windows, and inspect actual
packaged artifacts. Signing happens before archives are produced. Updates must
preserve user data and never interrupt active tasks without explicit consent.
Configuration mutations are project-scoped, validated on the server, and audited.
Verification includes pure unit tests, real API workflows, browser interactions,
and native packaged-app runs. Provider-dependent and hardware-dependent checks
remain open until they actually run.

## P0 Release Reliability

| Requirement | Current State | Evidence Required |
| --- | --- | --- |
| Windows installation, launch, upgrade, uninstall, paths, permission prompts, terminal, Git | Open; 0.5.1 cross-built and package-validated | Native Windows installer and workflow run |
| macOS Developer ID signing and notarization | Blocked dependency: local keychain has zero valid signing identities | codesign + stapler + Gatekeeper checks on distributed archive |
| Windows code signing | Open; certificate not configured | Valid Authenticode signature on EXE and installer |
| Updates: detect, download, install, rollback | Partial: 0.5.1 unsigned flow; Mac packaged check/download/cancel verified; Windows installer launch unit-tested | Real two-version upgrade/rollback with preserved data |
| macOS and Windows pre-release smoke tests | Partial: macOS packaged workflow passes; native Windows CI prepared, not run | Packaged app boot, SQLite, terminal and Git on both platforms |
| Cross-platform build-script parity | Partial: shared validator and Windows parity changes implemented; macOS rebuilt successfully | Native Windows execution and DMG check still required |

## P1 Task and Message Experience

| Requirement | Current State | Evidence Required |
| --- | --- | --- |
| Needs attention / awaiting permission / running / recent grouping | Verified: 8 priority/archive/pinning tests; browser checks at 1440px and 960px | `lib/task-groups.test.ts`, `e2e/task-groups-ui.mjs`, screenshots in `test-results/task-groups/` |
| Background task center | Partial: all-project listing and activity signals exist | Running, waiting, failed tasks across projects; navigation and actions |
| Retry, stop, continue, duplicate task | Partial | API and UI tests; no duplicate concurrent runs |
| Message search and in-session search | Partial: cross-session search API exists | Text/tool matches, navigation, empty/error states |
| Long histories: virtualization, incremental render, pagination | Partial: tail paging, bounded page size, `hasMore`, and scroll-to-load are implemented | Thousands-of-messages browser stress test and true DOM virtualization |
| Disconnect recovery and SSE status | Partial: reconnect client exists | Cursor replay, duplicates, offline/retry, no missing messages |
| Unread message count | Partial: sidebar unread task count is implemented and unit-tested | Per-message read markers and reconnect tests |
| Empty, error and permission-wait states | Partial | Browser coverage of all states and recoverable actions |

## P1 Workspace and Delivery

| Requirement | Current State | Evidence Required |
| --- | --- | --- |
| Debug area: Review / Files / Preview / Terminal / debug output | Partial: components exist | Selection persistence, resize, keyboard and state transitions |
| Delivery review: files, diff, tests, risks, accept / return / discard | Partial: delivery APIs and state machine exist | End-to-end immutable attempt and conflict/CAS tests |
| Export patch / commit delivery | Open | Apply exported patch; verified commit contains only approved changes |
| Git branches, commit, rollback, conflicts | Partial | Native and API tests with clean/dirty/conflicted repositories |
| HTML, image, Markdown preview | Partial | MIME/path isolation, responsive preview and rendering tests |
| Download / export result files | Open | Binary integrity, filename safety and authorization tests |

## P1 Agent Capabilities

| Requirement | Current State | Evidence Required |
| --- | --- | --- |
| Model, context, temperature, budget configuration | Partial | Validated settings actually applied to runs; capability limits enforced |
| Create / edit / delete / enable custom agents | Partial: workspace discovery exists | CRUD persistence and actual selected agent behavior |
| MCP server management | Partial: runtime and settings exist | Connect/disconnect/reconfigure, validation and errors |
| Skills management | Partial: discovery and loading exist | Inspect/install/enable/disable; path and size safety |
| Visual permission rule editor | Partial | Validated rule changes and real approval behavior |
| Project-isolated permission rules | Open | Two-project isolation, no global leakage |
| Model, tokens, elapsed time, cost | Partial | Accurate live and restored usage; unavailable cost is not zero |
| Structured failure recovery advice | Open | Typed failure categories with safe retry/repair actions |

## Progress Log

- 2026-09-07: inspected 0.5.0; identified native Windows packaging parity gaps,
  macOS signing-after-archive inconsistency, and absent Developer ID identity.
  Historical TODO documents contain stale claims; component existence remains
  classified as partial until verified.
- 2026-09-07 batch 1: implemented shared artifact and native-module validation,
  structured update-manifest checks, pre-archive macOS signing, Windows native
  script parity, signing preflight, and exclusion of all developer environment
  files from packages. Public production defaults replace bundled `.env`.
- Added isolated packaged-app smoke and native macOS/Windows CI definitions;
  Windows installer checks are CI-only. CI has not yet been dispatched.
- Local evidence: 92 Vitest tests, 16 node:test release checks, TypeScript check,
  rebuilt macOS ZIP signature/manifest checks, and two packaged-app smoke runs
  passed. Smoke includes real PTY (not pipe fallback), Git exit code, project
  paths with spaces, file I/O, SQLite session creation and restart persistence.
- New test package remains local at version 0.5.0; it is NOT a replacement for
  the released 0.5.0 artifacts. No new packages have been uploaded in this goal.
- ZIP was extracted to a new temporary directory; its signature passed and the
  extracted executable passed the same native smoke workflow. This verifies the
  distributed-format contents rather than only the builder's staging `.app`.
- P1 grouping browser checks passed at 1440px and 960px, including ordering and
  horizontal overflow. Preview server uses isolated test data on port 3101.
- 2026-09-07 batch 2: stable updater manifests now publish at the release root
  and rewrite artifact paths into immutable `v<version>/` folders; release-link
  output includes the stable feeds. Full Vitest (92), release tests (19), type
  check, and task-group browser checks passed. Renamed the Node updater source
  test so Vitest does not misclassify it as an empty suite.
- 2026-09-07 batch 2 verification: current packaged macOS smoke passed again
  with an isolated profile, SQLite session persistence across restart, a project
  path containing spaces, workspace read/write, native PTY terminal, and a real
  Git command. This does not substitute for native Windows execution.
- 2026-09-07 batch 3: added a visible sidebar unread-task count derived from
  background completion activity, excluding archived sessions and preserving the
  existing click-to-clear behavior. TypeScript and all 92 unit tests passed.
- 2026-09-07 batch 4: wired session sidebar refreshes to the existing `all=1`
  aggregate endpoint, so background tasks from every configured project appear
  in one task list. Current-project runtime creation and event subscriptions are
  unchanged; typecheck and all 92 unit tests passed.
- 2026-09-07 batch 5: reproduced and fixed updater publishing hazards in an
  offline OSS mock. Stable manifests now use validated `v<version>/` paths,
  failed artifact uploads cannot advance the stable feed, and stable YAML is
  marked no-cache. Added three uploader regression tests; release suite now has
  22 passing tests, alongside 92 unit tests and a passing typecheck.
- 2026-09-07 batch 6: added a real stop action to each running task's sidebar
  menu, wired to the existing abort API and an all-project list refresh. The
  action is hidden for non-running tasks; typecheck and all 92 unit tests pass.
- 2026-09-07 batch 7: completed a fresh production `next build`; compilation,
  route collection, type validation, static generation, and build trace
  collection all passed. No artifacts were uploaded as part of this check.
- 2026-09-07 batch 8: fixed full-text search scope to traverse every configured
  project store, matching the cross-project task center; current runtime store
  remains reused for the active project. Typecheck and all 93 unit tests pass.
- 2026-09-07 batch 9: fresh production build passed after the cross-project
  search change, including server route compilation and static generation.
- 2026-09-07 batch 10: packaged macOS smoke passed again after making its
  optional screenshot independent of remote font loading. Core evidence covers
  isolated launch, SQLite persistence, paths with spaces, file I/O, native PTY,
  Git, and restart recovery; visual screenshots remain covered by browser E2E.

## Next Batch

Search regression evidence (2026-09-07): five actual-route tests with mocked
stores cover cross-project matches, the global 30-result cap, database opening
and listing failures, and empty queries. Three failed before the fix and pass
afterwards. Full suite: 98 tests; typecheck and diff check pass. This is not yet
real-database or browser search evidence.

1. Verify real two-version upgrade and rollback without losing data. Detection,
   explicit download, integrity verification and confirmation now exist; see
   `unsigned-updates.md` and `release-0.5.1-verification.md` for the unsigned flow.
2. Run the native Windows workflow; do not equate workflow YAML with execution.
3. Complete background task center and retry/continue/duplicate actions, then
   in-session search, unread counts and bounded long-history rendering.
4. Continue the full workspace/delivery and agent capability tables above.
   Certificate provisioning remains an external dependency, not a reason to
   abandon other work or declare P0 complete.
