# Release checklist (App Store)

_Added with #37. Part of the release process in [versioning.md](versioning.md); the agent items run in `/implement`, the owner items
after the milestone UAT ([uat/README.md](uat/README.md))._

Who: **agent** = checked by the pipeline (a test or command), **owner** = done or confirmed by the owner. Tick an item (`[x]`) only
with its date and the issue. The current 1.0.0 status is at the end.

## Automated (agent)

- [ ] `scripts/gate.sh` is green on the branch head: `npm ci`, lint, `format:check`, build, tests, `release:check`, `homey app validate`.
- [ ] `npm run release:check` passes: all versions agree and the changelog has an entry for the current version (#38).
- [ ] `homey app validate --level publish` passes (the gate validates at the default level; publish level is the App Store level).
      Expected: `App validated successfully against level 'publish'`.
- [ ] The store tests are part of `npm test`: `src/storeAssets.test.ts` (icons, images, name, slogan, readmes, links, brand colour,
      `assets/` content, `.homeyignore`), `src/manifest.test.ts` (`store i18n`, settings, cards) and `src/changelog.test.ts`
      (changelog structure).

## Bundle (agent)

- [ ] `rm -rf .homeybuild && homey app build`, then `ls -a .homeybuild`: no `docs/`, `scripts/`, `CLAUDE.md`, `README.md`,
      `eslint.config.mjs`, `.github/`, `.claude/`, `.hwtest/`, `.venv/` and no `assets/source.png` (`.homeyignore`, see
      [architecture/store-assets.md](architecture/store-assets.md#app-bundle)). `README.txt` and `README.de.txt` stay.
- [x] The app starts from the built bundle: a hardware smoke test after any `.homeyignore` change (no `Cannot find module` or `ENOENT`).

## Listing (agent, owner decides the content)

- [ ] Name `Divoom TimeBox Evo` (owner, 2026-10-18) and slogan (`description`) in en and de (`src/storeAssets.test.ts`).
- [ ] Store readmes `README.txt` / `README.de.txt`: plain text, at most two paragraphs, no URLs or markdown, only shipped features
      (test + read once before the release; the owner confirms the wording).
- [ ] App icon `assets/icon.svg` and driver icon: monochrome vector, 960 x 960 viewBox (test); driver icon strokes 40/20/10 px (guideline 1.6, test). Path data: defensive canonical form, one command per segment, app icon only absolute `M H V L Z` without `fill-rule` (#147, test; kept: UAT v1.1.0 accepted 2026-10-18 with the icon shown in Devices > "+"); the icon must also show on the store page of the published test build (owner, after publish).
- [ ] App images 250x175, 500x350, 1000x700 and driver images 75, 500, 1000 px square (test); the owner looks at them in the Homey app.
- [ ] `brandColor` is `#RRGGBB` (test); the owner confirms the colour.
- [ ] Links `source`, `support`, `bugs.url` in `.homeycompose/app.json` and `app.json` (test).
- [x] Guideline 1.5: the pixel-fox app icon is kept, Divoom has no usable company icon (owner decision, 2026-10, #37).
- [x] Guideline 1.6: the driver icon angle is kept, it shows the right side (owner decision, 2026-10, #37).

## i18n (agent)

- [ ] English and German texts are complete for all Flow cards, arguments, settings, capabilities and pairing views
      (`store i18n` tests in `src/manifest.test.ts`); German uses real umlauts (`docs/conventions.md`).

## Changelog (agent, in the release commit)

- [ ] `.homeychangelog.json` has the entry (en + de) for the new version, written in the `chore(release): vX.Y.Z` commit
      (`docs/versioning.md`); the structure is tested. `npm run release:check` verifies that it has an entry for the app version and none newer (#38); `npm run release:bump` writes it.

## Owner

- [ ] The milestone UAT is accepted (`docs/uat/`).
- [ ] (agent, after owner UAT acceptance) `chore(release): v1.0.0` is merged and the tag `v1.0.0` is pushed, as in [versioning.md](versioning.md#mechanics); the publish stays with the owner.
- [ ] The repository is public, so `source`, `support` and `bugs` resolve.
- [ ] `homey app publish` from the tagged commit (draft build, test channel). Answer No to the CLI's version-bump prompt and to its git commit/tag offer (version and tag exist already, see [versioning.md](versioning.md#release-procedure)).
- [ ] Install from the test channel on the Homey and run a smoke test: pair, switch the mode, show a text.
- [ ] Submit the build for certification in the Homey App Store.
- [ ] After certification, promote the build to live.
- [ ] Create the Homey community topic, then add `homeyCommunityTopicId` (positive integer) to `.homeycompose/app.json` and release
      it as a PATCH version.

## 1.0.0 status

Agent items, #37, 2026-10-16:

- [x] Gate green (2026-10-16, #37).
- [x] `homey app validate --level publish` passes (2026-10-16, #37). Output: `App validated successfully against level 'publish'`.
- [x] Store tests: icons, images, name, slogan, readmes, links, brand colour, `assets/` content, `.homeyignore`, i18n, changelog
      structure (2026-10-16, #37).
- [x] Bundle: `.homeybuild` has no `docs/`, `scripts/`, `CLAUDE.md`, `README.md`, `eslint.config.mjs`, `.github/`, `.claude/`,
      `.hwtest/`, `.venv/` or `assets/source.png` (2026-10-16, #37).
- [x] i18n en + de complete (2026-10-16, #37).
- [x] Hardware bundle smoke test (`/hwtest`, #37; passed 2026-10-16): start from the built bundle, show text, countdown 0 error; no `Cannot find module`, `ENOENT`, `Uncaught`, `unhandled`, crash or `permanent error` in the log.
- [ ] Changelog entry for 1.0.0: written with `chore(release): v1.0.0`.
- [x] Release process dry run, #38, 2026-10-16: `npm run release:check` passes (`release check: all versions are consistent`).
      `npm run release:bump -- 1.0.0 --en "Dry run" --de "Probelauf" --note "dry run" --dry-run` prints (condensed):
      ```
      Dry run, nothing written. Would bump to 1.0.0:
        .homeycompose/app.json (version): 0.5.0 -> 1.0.0
        app.json (version): 0.5.0 -> 1.0.0
        package.json (version): 0.5.0 -> 1.0.0
        package-lock.json (version): 0.5.0 -> 1.0.0
        package-lock.json (packages[""].version): 0.5.0 -> 1.0.0
        README.md: > Current version: 0.5.0 (milestone Images, ...). ... -> > Current version: 1.0.0 (dry run). ...
        .homeychangelog.json: (no entry) -> entry 1.0.0
        changelog entry 1.0.0: {"en":"Dry run","de":"Probelauf"}
      ```
      Afterwards `git status --porcelain` shows no changes except this documentation, and `git tag -l v1.0.0` is empty: nothing was
      bumped or tagged. The real bump follows the UAT acceptance ([versioning.md](versioning.md#release-procedure)).

Owner items (all open): UAT, public repository, publish, test channel, certification, live, community topic. The release commit and
tag are done by the agent after the owner accepted the UAT.
