# Windows 0.5.1 cross-volume startup failure

Status: DONE_WITH_CONCERNS — source fix, regression tests and 0.5.2 Windows
candidate EXE/ZIP complete; no native Windows retest or public release yet.
See `../docs/release-0.5.2-windows-verification.md` for isolated build provenance.
Candidate files are in `/Users/ulanxx/Downloads/Lectern-0.5.2-Windows/`.

## Evidence and root cause

User supplied `/Users/ulanxx/Downloads/web.log`. It contains older 0.4.3 errors
as well as multiple 0.5.1 launches; do not conflate those versions.
The 0.5.1 startup at 2026-09-07T23:42:44Z reports win32-x64, a writable data
directory, available node:sqlite, and a successful SQLite open. Server cwd is on
C:, while the application archive is installed on D:. Both homepage and error
page fail inside `RouteModule.prepare` with `Invalid package` and a malformed
path containing the C: user profile followed by the D: application path twice.

Next 15.5.21 router-server/next-server use `path.relative(cwd, dir)` to set
`relativeProjectDir`. Across Windows drives this returns an absolute D: path.
RouteModule then uses `path.join(cwd, relativeProjectDir)`, which appends that
absolute drive path instead of replacing cwd. Subsequent distDir reconstruction
and instrumentation loading compound the malformed path. This matches the
reported exception. Chinese characters are not the cause; same-volume paths
do not trigger this calculation failure.

## Fix

`electron/main.cjs` starts the Windows utility process with cwd equal to
`process.resourcesPath`, the real directory containing app.asar on the same
volume. It does not chdir into the archive. macOS keeps the existing cwd.
Explicit data/workspace/log environment variables still point at userData,
including existing legacy data/data selection; no data is moved or deleted.

## Verification

- Added `electron/web-server.source-test.cjs`, executing the actual main process
  launch function in a VM with Electron/filesystem stubs and Node win32 path
  semantics. Checks Next project/dist path reconstruction and retained user
  data locations for different drives, same-drive Program Files, Chinese and
  spaces, UNC paths, legacy data and macOS.
- Before fix: cross-drive and UNC cases fail, other two pass.
- After fix: all four pass; added to test:release.
- `pnpm test:release`: 33/33 pass.
- `pnpm test`: 131/131 pass in the current working tree (which also contains
  unrelated in-progress workflow changes).
- `node --check electron/main.cjs` and `git diff --check` pass.

## User workaround and remaining validation

For the user's portable ZIP install, close Lectern and move the entire Lectern
application folder to a writable location on C: (the same drive as AppData),
then run Lectern.exe there. This avoids the confirmed cross-drive calculation;
it has not yet been verified on that user's machine. Leave AppData intact.
Update: user confirmed moving the application to C: makes it work. This supports
the cross-volume root cause. The 0.5.2 candidate can now be tested back on D:.
Before claiming Windows release acceptance, run the rebuilt packaged app with
installation and userData on different drives and verify homepage, APIs and
restart persistence. Existing downloadable 0.5.1 packages are unchanged.
