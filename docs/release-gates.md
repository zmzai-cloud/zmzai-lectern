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
Windows installer evidence, real signed artifacts and cross-version update
tests remain mandatory before closing the corresponding P0 requirements.
