# Desktop Release Gates

## Local Checks

Run `pnpm test`, `pnpm test:release`, then the platform's build command. Build
scripts preserve previous build output in the system temporary directory, start
from a clean Next output, inspect standalone data, patch its asar-incompatible
working-directory change, prune target-native dependencies, and verify packages.
Do not run the development server against the same `.next` directory during a
release build.

`pnpm test:packaged` launches the actual packaged executable in an isolated
profile. It verifies page rendering and the platform bridge, creates a project
whose path contains spaces, persists a session, reads/writes a file, runs Git in
the packaged terminal, and restarts the app to check persistence. No model call
or real user account is needed. Reports and screenshots live in `test-results/`.
Temporary profiles are retained for diagnosis; their paths are printed.

The Windows installer smoke runs only in an isolated CI runner. It silently
installs to a unique temporary directory, executes the same packaged workflow,
and checks uninstall. This is not proof of cross-version upgrade/rollback or
human interaction with SmartScreen and permission dialogs.

`e2e/windows-cross-drive-smoke.ps1` also runs in the Windows CI job. It maps an
unused drive letter to an isolated fixture, copies the packaged application to
a path with Chinese characters and spaces, and runs the packaged workflows with
the profile on a different drive. The smoke asserts the actual app path crosses
drives and checks homepage HTTP 200, UI readiness, APIs, terminal and restart
persistence. Reports are kept in `test-results/packaged-cross-drive/`. This gate
was added after the 0.5.1 D:-install/C:-profile startup failure; a passing path
unit test or cross-build alone is not a native Windows acceptance result.

A release additionally requires a passing rendering-layer E2E run on the commit
being shipped; building and smoke-testing the package is not sufficient on its
own. See the section below.

## Release gate: rendering-layer E2E

`node scripts/upload-oss.mjs` refuses to upload unless the `ui-e2e` workflow
passed on the exact commit being released. The uploader asks the GitHub API for
that commit's runs (`scripts/ui-e2e-gate.mjs`) before writing a single object, so
a release whose interface is broken cannot ship even when the desktop packages
build cleanly and pass their own smoke tests. The two gates answer different
questions: `test:packaged` says the package starts, this one says the UI behaves.

The gate fails closed. Three outcomes all stop the upload, and the message says
which one happened:

- `query_failed` — `gh` is missing, unauthenticated, rate-limited, or the network
  failed.
- `no_run` — the commit has no `ui-e2e` run at all.
- `failed` / `pending` — the latest finished run is not `success`, or nothing has
  finished yet. A `cancelled` run is **not** a pass: a run cancelled by
  `cancel-in-progress` is precisely the "did not finish" case this gate exists for.

Judgement is on the latest **finished** run per commit, not "any run succeeded" —
a commit that went green and then red on a re-run does not earn a release.

Because this repository is public and `main` has no branch protection, the gate
cannot be a GitHub required status check; the local check is what enforces it. Do
not add `paths-ignore` to `ui-e2e.yml` to make the gate easier to satisfy: CI
minutes are free here, and once branch protection is enabled a docs-only pull
request would leave its required check pending forever.

`--dry` prints the verdict but does not block, since a dry run writes nothing —
it exists to preview what would be uploaded. Any real upload goes through the
gate.

Check a commit without uploading anything:

```
node scripts/ui-e2e-gate.mjs --sha <commit>
```

Scope: this covers the rendering layer — browser E2E against a source build plus
the two native clipboard jobs. It is not evidence about packaged installers;
those stay with `test:packaged` and the Windows installer / cross-drive smokes
above.

## Signing

Default local macOS builds use ad-hoc signing before ZIP/DMG creation; Windows
local builds can remain unsigned. Neither qualifies as a trusted signed release.
Archives are never rewritten after signing, so their blockmaps and update
manifests describe the same bytes users download.

For a trusted release set `LECTERN_REQUIRE_SIGNING=1`:

- macOS needs `CSC_LINK` (certificate file/encoded certificate) or `CSC_NAME`,
  plus notarization credentials: `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
  `APPLE_TEAM_ID`; alternatively Apple's API-key variables or
  `APPLE_KEYCHAIN_PROFILE`. Use `CSC_KEY_PASSWORD` for the imported certificate.
- Windows needs `WIN_CSC_LINK` or `CSC_LINK` with its certificate password.
  Native Windows builds verify Authenticode for the app and NSIS installer.
- Missing configuration stops the build. macOS additionally runs `codesign`,
  `stapler validate`, and `spctl` after packaging. Certificate validity and
  notarization must actually pass; preflight alone is not evidence of signing.

No certificate is bundled with the app. Developer `.env*` files are excluded.
Desktop production defaults are public service addresses in
`electron/release-defaults.cjs`; explicit process environment and saved user
settings retain their precedence.

## Publishing

`node scripts/release-validation.mjs release dist` requires both platforms.
Supply `darwin` or `win32` as the last argument for a single-platform check.
The OSS uploader runs this validator before uploading any artifact. It rejects
stale builds, incomplete platform sets, unsafe paths, mismatching sizes/hashes,
and orphan blockmaps. SHA-256 checksums also cover uploaded blockmaps.

The CI workflow performs native platform builds and packaged smoke tests without
publishing, and does not expose signing credentials to pull requests. Native
Windows installer evidence and real signed artifacts remain mandatory before
closing the corresponding P0 requirements. Cross-version update tests are
described under "Cross-version update path" below.

## Cross-version update path

The updater is first-party (`electron/updater.cjs` + `electron/update-contract.cjs`),
not `electron-updater`: `electron/updater.source-test.cjs` asserts the source never
references `quitAndInstall`, `autoUpdater`, `execSync` or `xattr`. Nothing replaces
the app silently, and nothing strips quarantine. **Unsigned builds therefore do not
block this channel** — macOS reveals the verified ZIP in Finder for the user to swap
in, Windows launches the installer and then quits. Code signing stays an independent
concern: it only decides whether Gatekeeper / SmartScreen interrupt that manual step.
Do not schedule the two as one item.

Two facts about a published version need evidence, and neither is covered by the
build-time gates above:

1. **The artifacts are intact on the public feed.** `pnpm verify:public` re-reads
   `latest-desktop.json`, both stable manifests and every artifact, hashing each
   download byte for byte against `dist/`. A successful upload is not evidence —
   only a read-back is. This script existed from the start but sat outside every
   npm script, so a release could ship without it ever running; it has a name now,
   and the uploader prints it as the next step.
2. **The previous release can see this one.** `pnpm verify:update-path` extracts
   `update-contract.cjs` from the *installed* app — so the comparison runs the code
   users actually hold, not today's source — asserts it selects the new version
   from the live feed, then launches that app under an isolated
   `LECTERN_USER_DATA_DIR` and watches the status go `idle` → `available`. Add
   `--download` to also fetch and hash the real artifact (210 MB); `--contract-only`
   skips the GUI.

The GUI step is also the only coverage for the startup auto-check
(`electron/main.cjs`, `setTimeout(check, 10_000)`) actually firing.

Neither script belongs in CI: both need the public network, and (2) needs a
previously released build installed locally. Run them after every release, in that
order. They do not replace the packaged smoke test.
