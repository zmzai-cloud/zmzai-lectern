# Lectern 0.5.2 Windows Hotfix Candidate

Prepared 2026-09-08 for the 0.5.1 cross-drive startup failure. Public release
feeds have not been changed. Native Windows acceptance is still pending.

## Change

The Windows utility process now starts with `process.resourcesPath` as cwd,
on the same drive as the packaged Next application. Next 15.5.21 can therefore
reconstruct its project path without joining a C: profile path to a D: absolute
installation path. User data, workspace and logs retain their existing explicit
AppData paths, including legacy data/data selection. macOS cwd is unchanged.

## Build Provenance

- Isolated source: commit `07c0031` (0.5.1 release) plus the startup fix and tests.
- Staging directory: `/tmp/lectern-win-0.5.2-KZu0yl`.
- Version 0.5.2 is set in the isolated build package. The shared working tree
  contains unrelated in-progress work; it was not used as release input.
- Runtime: original 0.5.1 Windows `dist/win-unpacked/resources/app.asar`, extracted
  with `@electron/asar` and copied with relative symlinks preserved. This reuses
  the released Next output and Windows native dependencies byte for byte.
- Packaging: electron-builder 26.15.3, Electron 44.0.0, Windows x64, NSIS and ZIP,
  `--publish never`. No developer `.env` was copied into staging.
- A fresh Next build was attempted, then stopped during excessive dependency
  glob tracing. None of its partial output is used in these packages.

## Verification

- Isolated source `pnpm test`: 102/102 pass.
- Isolated source `pnpm test:release`: 33/33 pass, including C:/D:, same-volume,
  Chinese/space paths, UNC and legacy-data cases.
- Package validation: 0.5.2, win32-x64, 10133 archive entries; required native
  dependencies unpacked; no private data or opposite-platform native modules.
- Compared 8803 existing archive file contents with the released 0.5.1 archive.
  Only `electron/main.cjs` and root `package.json` changed; the only addition is
  `electron/web-server.source-test.cjs`. No original archive entries were removed.
- Final package hashes and file sizes are provided beside the candidate files.
- Final `release-validation.mjs release dist win32` passes for EXE, ZIP,
  installer blockmap and latest.yml; `unzip -tq` reports no compressed-data errors.
- Candidate output: `/Users/ulanxx/Downloads/Lectern-0.5.2-Windows/`, including
  SHA256SUMS.txt, files.json, README.md and this verification record.

## Remaining Native Acceptance

`e2e/windows-cross-drive-smoke.ps1` and the Windows CI job now include a separate
drive-letter fixture with Chinese/space installation paths. The packaged smoke
requires homepage HTTP 200, visible account controls, actual separate app/profile
drives, API and terminal workflows, and restart persistence. This new native
gate has not been executed on the local macOS host.

For affected-user verification, exit Lectern completely, install 0.5.2 on D:
or extract the candidate ZIP into a new D: folder, and launch that executable.
Confirm the homepage, existing sessions, a new task and restart persistence.
Keep the AppData directory intact. A passing test is required before claiming
native Windows acceptance or promoting these artifacts to the stable feed.
