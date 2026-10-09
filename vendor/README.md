# Vendored framework package

`zmzai-agent-framework-0.17.2.tgz` is the immutable tarball of
`@zmzai/agent-framework@0.17.2`, vendored here so desktop builds and clean
installs resolve the framework without depending on registry access. The
framework repository is the source of truth; the version number is unique to
these bytes and never re-packed under the same name (spec 2026-09-28 §8).

What 0.17.2 changed (subagent activity replay):

- The session-restore `stateEvents` query never included
  `subagent.started/step/finished`, so reopening a session left every subtask
  row stuck on 执行中 forever — the UI attaches subagent activity when those
  events replay, but they were simply not returned. The query now matches the
  three subagent event types alongside the collapse-resistant incremental
  events (no `MAX(seq)` collapse for them, same as before).

What 0.17.1 changed (fs workspace symlink robustness):

- Production incident (2026-10-08): opening a home-directory snapshot as a
  local project made every `glob`/`grep` call fail with `ENOENT: no such file
  or directory, open '<root>/.workspace/agent'`. The snapshot contained broken
  symlinks (`agent -> /mnt/...`, targets not present on this machine);
  `createFsWorkspaceFiles.list()` walked with `readdir` Dirents (which do not
  follow symlinks), fell through to `readFile`, and one broken link killed the
  whole listing.
- Fix: the walk now `stat`-follows symlinks (skipping broken ones silently),
  follows directory symlinks only when they resolve back inside the workspace
  root (listed paths must stay readable via `safeJoin`), dedupes by `realpath`
  to terminate symlink self-loops, and tolerates per-entry read failures.
  Regression tests cover broken / in-root / escaping / looping / file symlinks
  plus a list↔read consistency assertion.

What 0.17.0 changed (T06, production-chain fault closure):

- End-to-end subagent chain test on the real runner (command service →
  scheduler → task lifecycle → attempt executor → real `subagentTools` with a
  scripted model): double `agent_spawn` → parent parks → children run real
  `runAttempt` → same-transaction settle + result mail → wake → automatic
  resume → mailbox drained into the resume advisory (no synthetic user
  message) → `task_deliver` → delivered in exactly two attempts.
- Durable wake reconciliation on restart: a parked parent task with
  unconsumed `to_parent` results is itself the persistent wake state —
  coordinator recovery rebuilds the wake through the terminal hook (the
  in-process resume Set dies with the process); terminal parents are never
  revived.

What 0.15.0 changed (T05, parent lifecycle & acceptance):

- F03 fix: `completionStateOf` queries real subagent records instead of a
  hardcoded `null`. The delivery gate blocks on non-terminal children,
  terminal-but-unconsumed results, and needs_revision/rejected children that
  have not been replaced or re-accepted; the completion path is reachable
  (terminal + drained → deliver).
- Parent park is wired into the real task loop: a continue verdict with
  necessary children pending parks the task (`parkedReason: "children"`, stays
  `running`, no attempts burned). Child-terminal wakes resume via
  `driveResumedTask`; the resumed run drains the parent mailbox into the
  attempt advisory (system instruction, no synthetic user message) and commits
  the consumption watermark only after the attempt persisted.
- Acceptance service: `coordinator.reviewChild(childId, decision, {note,
  evidenceRefs}, scope)` records accepted/needs_revision/rejected bound to the
  child result revision; rework spawns link `replacesChildId` and unblock
  delivery once the replacement is terminal and consumed.
- Root cancellation cutoff: `runner.abort` settles the task terminal first
  (late child results cannot revive it), then `cancelTree` closes coordinator
  admission for that root (pump/launch re-check; the pump raced ahead and
  launched queued children during cancellation — caught by the PC09 test) and
  cancels the whole tree.

What 0.14.0 changed (T04, persistent queue / mailbox / wake):

- Durable queue: `SubagentRecord.prompt` persists the spawn input; the
  coordinator's in-memory queue is only a cache. On construction it reconciles
  with the store — queued children re-run from their persisted prompt,
  running/cancelling children from a previous process land in `blocked`
  (recovery review, no side-effect replay), waiting states are restart-safe.
- `settleSubagent` (new store face): child terminal state + the `to_parent`
  result message commit in one SQLite transaction; `messageId` derived from
  childId+revision is idempotent across replays.
- Wake hook: `deps.onChildTerminal(child, parentSessionId)` fires after the
  settle transaction; hosts wire it to `runner.requestInternalResume` (new
  public API — same channel as the user resume button, no synthetic user
  message).
- `agent_send` reaches the child context by state: queued → injected into the
  launch prompt; active run → `deps.deliverToChild` (host wires
  `runner.prompt`, FIFO queued prompts are the safe boundary, requestId =
  messageId for idempotency); `waiting_input` → re-queued and resumed with the
  new message; `waiting_permission`/`waiting_external`/`blocked` only land in
  the mailbox (messages never substitute approvals or clear safety blocks).
- `drainParentMailbox` is two-phase (`results` + `commit()`): the consumption
  watermark only advances after the results are durably in the parent context —
  a crash between read and commit re-reads idempotently instead of losing
  results (PC06).

What 0.12.0 changed (T02, unified child-session creation):

- `FrameworkDeps.subagentCoordinator` — explicit field, passed through to
  `SessionRunner` and bound to runner-sourced session registry resolution +
  depth. Previously hosts passed the coordinator via conditional spread, which
  TypeScript's excess-property check skipped and `createServer` silently
  dropped (F01: `agent_spawn` registered but `ctx.subagents` never injected).
- Unified `ChildSessionFactory` (`createDefaultChildSessionFactory`, exported):
  parent identity resolved from the store (no more fake `{ id }`-only sessions
  reaching creation — `userId: undefined` crashed SQLite binding), permission
  stamping, preset/parent model inheritance, `writePaths` confinement, and
  deterministic child session ids keyed by `spawnRequestId` +
  `creationRequestId` so a crash between session creation and record creation
  does not duplicate the child on retry (PC04).
- `spawnRequestId` derivation from the persistent tool-call id (`toolCallId`)
  when the model does not supply one; same-key-different-payload retries are
  rejected (`SPAWN_PAYLOAD_MISMATCH`); subagent nesting depth is resolved
  server-side inside the coordinator.

What 0.13.0 changed (T03, outcome propagation + admission):

- `runChild` now returns a structured `ChildRunOutcome`
  (`completed/failed/cancelled/blocked/waiting_*` + `summary`,
  `evidenceRefs`, `unknownSideEffect`, `errorMessage`) instead of a bare
  `WorkflowState`; the coordinator projects it into the record — child failure
  lands as `failed` with `blockerReason` and `result.outcome`, never masked as
  `completed` (PC02 / F02).
- `SubagentAdmission` / `createSubagentAdmission` (exported): process-wide
  shared run-slot accounting across per-project coordinators, so the "Host
  total 6 / 3 per root" limits are global, not per-project; releases notify
  other coordinators' queue pumps (PC03).
- `send`/`wait`/`cancel` accept a `scope: { rootTaskId }` and reject
  out-of-tree child ids (`CHILD_OUT_OF_SCOPE` / `SCOPE_VIOLATION`);
  `agent_*` tools pass the injected scope.
- `RunOutcome` is exported for hosts consuming `runAttempt` results.

Daily development against the sibling working tree: use
`scripts/framework-dev.sh on|off` (switches the dependency to
`file:../zmzai-framework` and back). Never commit `package.json` /
`pnpm-lock.yaml` while linked. See
`docs/superpowers/plans/2026-09-21-framework-dev-linking-adr.md`.

Regenerate after framework changes:

```bash
# in ../zmzai-framework
pnpm build && npm pack --pack-destination ../zmzai-lectern/vendor
# then bump the file: dependency spec and re-resolve the lockfile
pnpm install --lockfile-only
```

Lectern pins the tarball path and its integrity in `pnpm-lock.yaml`.

## Historical: what 0.5.1 added

- Session workflow persistence: `acceptPrompt` / `claimPrompt` / `finishPrompt` /
  `recoverInterrupted` with single-transaction registration, requestId
  deduplication, FIFO queues, monotonic `revision` and rewind cursor invalidation.
- Message snapshots (`getMessageSnapshot` with before/after/around) and normalized
  search (`searchMessages`) plus persisted read state. Search indexes text, tool
  names/titles and attachment filenames only — never reasoning, tool inputs or
  output logs, attachment URLs or contents. Common credential patterns are
  redacted, which is not a guarantee of arbitrary secret detection.
- Input attachments: UTF-8 text/code, five files, 512 KiB each. Binary document
  parsing is not implemented; unsupported formats are rejected explicitly. User
  text and stored file parts stay separate — only the model adapter expands file
  bytes into labeled content blocks. Queues and history rebuilding preserve
  attachments; rewind resends their stored data.
- Gap-safe event replay, setup cancellation, atomic workflow settlement and lease
  release, complete interrupted-event recovery.
- Windows: terminal prefers `pwsh.exe` / `powershell.exe` with `cmd.exe` as a
  fallback, and PTY, pipe and MCP stdio children are terminated as process trees.
- Windows terminal exit fix (0.5.1): the PowerShell shells no longer start with
  `-NoExit`. That flag kept PowerShell alive after the command finished, so the
  process never exited and every Windows terminal session stayed `running`
  forever — `terminal_read` never reported an exit code and the packaged smoke
  ("Terminal did not exit") failed on Windows. The shell spec is now a pure
  `shellSpecFor` function covered by a unit test.

## Windows requirements

Install Git for Windows including Git Bash. The subprocess sandbox locates Unix
executables through PATH and standard system or per-user Git installations, and
supplies their directory to child shells. Custom installations can expose
`usr\bin` on PATH. Restart Lectern after installing Git or changing PATH.

## Outstanding verification

Real-provider runs, desktop drag/drop acceptance, native Windows execution and
system-scaling checks are still outstanding; the framework regression suite
covers the logic above, not those environments.
