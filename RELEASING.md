# Releasing

The `release` workflow runs every Monday, or run it by hand from `main`. Leave `version` empty to bump the latest
release's minor version, or pass a full `vX.Y.Z`. Releases are immutable full versions; there is no floating major
tag. A release tag is `main` plus one commit that keeps only the actions, `LICENSE` and `README.md`, and its notes
link to the diff of those files since the previous release. When those files are unchanged since the previous
release, the run skips the release. Tick `dry-run` to see the version and release commit a run would create, with
no tag or release; a dry run can run from any branch.

The release steps' logic lives in `.github/scripts/release.js`; run its tests with `bun test`.
