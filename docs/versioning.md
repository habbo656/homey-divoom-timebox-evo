# Versioning

The app follows [Semantic Versioning 2.0.0](https://semver.org): `MAJOR.MINOR.PATCH`.
Homey App Store versions are plain `X.Y.Z` (no pre-release or build suffixes); test builds use the store's test
channel instead.

## What counts as what

The public API of this app is what users build on: driver ID, capability IDs, device setting IDs, Flow card IDs and
their argument IDs/values, and stored device data needed to keep paired devices working.

| Bump | When (from 1.0.0 on) | Examples |
|---|---|---|
| MAJOR | A change that breaks existing Flows or paired devices | removing/renaming a Flow card, argument or dropdown value; changing a capability ID; requiring re-pairing |
| MINOR | New, backwards-compatible functionality | new Flow card, capability, device setting, dropdown value |
| PATCH | Backwards-compatible fixes | bug fixes, performance, translations, docs, dependency updates |

Before 1.0.0 (`0.y.z`) breaking changes are allowed in a MINOR bump, but are listed in the changelog.

## Release lines

- `0.1.0`: legacy prototype (SPP-over-BLE, software text). Never released.
- `0.2.0` … `0.5.0`: one MINOR release per milestone (`docs/roadmap.md`). Fixes in between are PATCH releases.
- `0.3.0` was not released (#117); it is folded into `0.4.0`, so `.homeychangelog.json` has no `0.3.0` entry (`src/changelog.test.ts` checks the file structure).
- `1.0.0`: first public App Store release. From here on the compatibility rules above are binding.

## Mechanics

- The version lives in six places, all changed by one commit `chore(release): vX.Y.Z`: `.homeycompose/app.json` (source of truth),
  the generated `app.json`, `package.json`, `package-lock.json` (root `version` and `packages[""].version`), the `.homeychangelog.json`
  entry and the README line `` > Current version: X.Y.Z (<note>). Changelog: `.homeychangelog.json`. `` (exactly one such line).
  `npm run release:bump` changes all of them, `npm run release:check` verifies them (#38, `scripts/release.mjs`).
- `npm run release:check` fails on any version mismatch between those files, on a missing changelog entry for the current
  version and on a changelog entry newer than the app version. It runs in `scripts/gate.sh` and in CI (step "Release version
  check"), and every error names the file and the value.
- `.homeychangelog.json` gets an entry per version (`en` + `de`), written from the Conventional Commit history
  (`feat` → MINOR, `fix` → PATCH, `!`/`BREAKING CHANGE` → MAJOR).
- The release commit is tagged `vX.Y.Z` (annotated) on `main`. GitHub milestones are named after the version they ship in.
- Breaking changes known before a release are collected in `docs/roadmap.md` as "Breaking changes in <version>" and go into the changelog;
  after the release the list moves to `docs/archive/breaking-changes.md`.
- A version is released only after the owner accepted its milestone UAT (`docs/uat/v<version>.md`; moved to `docs/uat/archive/` once accepted). Finishing an accepted
  UAT includes the bump commit `chore(release): v<version>` (exactly that milestone's version, with its changelog entry and the
  README version line) and, once it is merged, the tag `v<version>` on that squash commit, pushed to `origin`, so the owner
  can release it; the publish stays with the owner (owner rule, 2026-10-07).
- The owner publishes (`homey app publish`), tests on the test channel, then promotes to live. The App Store checklist (bundle,
  listing, i18n, changelog, certification) is [release-checklist.md](release-checklist.md).
- Development builds on the owner's Homey (`homey app run`) carry the last released version; there is no `-dev` suffix.

## Release procedure

Prerequisite: the owner accepted the milestone UAT (`docs/uat/v<version>.md`). Agents never publish.

### Agent (after `ACCEPTED`)

1. Branch `agent/release-vX.Y.Z` from an up-to-date `main`. Write the changelog texts (en + de) from the Conventional Commit
   history and look at the result first:
   `npm run release:bump -- X.Y.Z --en "…" --de "…" --note "milestone <name>, accepted <date>" --dry-run`.
   It prints `file: before -> after` for every change and the changelog entry, and writes nothing. `X.Y.Z` may also be
   `major`, `minor` or `patch`; it must be a plain version greater than the current one.
2. Run the same command without `--dry-run`. It refuses to start when `release:check` fails, when a text is empty, when the
   changelog already has the key, and it aborts before writing if a file would change by more than its version fields.
3. `scripts/gate.sh` must be green (it runs `release:check`).
4. Commit `chore(release): vX.Y.Z`, open the PR and squash-merge it (the squash commit subject is `chore(release): vX.Y.Z (#n)`).
5. `git switch main && git pull --ff-only`, then `npm run release:check` and `git log -1 --format=%s` (must be
   `chore(release): vX.Y.Z (#n)`).
6. Tag that squash commit and push the tag: `git tag -a vX.Y.Z -m "vX.Y.Z" <squash sha>` and `git push origin vX.Y.Z`.
   Notify the owner "ready for release".

`homey app version` is not used: it updates neither `package-lock.json` nor the README line, and it tags the branch commit
instead of the squash commit on `main`. `npm version` only handles the package files.

### Owner

1. From the tagged commit run `homey app publish`. Answer **No** to the CLI's offer to bump the version and **No** to its offer to
   create a git commit and tag: the version and the tag already exist.
2. Install the draft build from the test channel on the Homey and run a smoke test (pair, switch the mode, show a text).
3. Submit the build for certification in the Homey App Store.
4. After certification, promote the build to live.

The App Store items (bundle, listing, i18n) are in [release-checklist.md](release-checklist.md).
