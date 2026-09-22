# Vendored framework package

`zmzai-agent-framework-0.10.0.tgz` is the published npm package
`@zmzai/agent-framework@0.10.0`, vendored here so desktop builds and clean
installs resolve the framework without depending on registry access. The tarball
is byte-identical to the registry artifact; the framework repository is the
source of truth and its `main` matches this version.

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
