# Owner acceptance tests (UAT)

Every milestone ends with a manual acceptance test by the owner in the Homey app (ADR 0007). The pipeline writes the
test instructions, the owner tests and gives a verdict, findings become bugs that the pipeline fixes, and the next
milestone starts only after acceptance. A milestone is released only after acceptance (`docs/versioning.md`).

## Flow
1. Last issue of the milestone merged → `/autopilot` runs `/uat <version> prepare`:
   doc-keeper writes `docs/uat/v<version>.md` → tester pre-checks the `[auto]` cases on `main` → the orchestrator runs
   `scripts/homey-run.sh stop --uninstall`, so no kept dev build (and its idle uninstall up to 8 h later) overlaps the
   owner's install → UAT issue `UAT v<version>: <milestone>` (label `uat`) with a checklist → ntfy message to the owner.
   The autopilot stops.
2. Owner installs the build and works through `docs/uat/v<version>.md`, ticking the checklist on the UAT issue.
3. Owner gives the verdict as a comment on the UAT issue (or as an ntfy reply):
   - `ACCEPTED` — optionally followed by remarks.
   - `REJECTED UAT-3, UAT-7` — followed by what you saw for each failing case (photo/description).
4. Next `/autopilot` run: on `ACCEPTED` it closes the issue, records the acceptance here and in `docs/roadmap.md`, moves the
   UAT doc to `docs/uat/archive/`,
   ships the version bump `chore(release): v<version>` and tags it `v<version>` (`npm run release:bump`, see the release
   procedure in `docs/versioning.md`, owner rule 2026-10-07), notifies
   "ready for release" and continues with the next milestone. On `REJECTED` it files one `uat-finding` bug per
   failing case, fixes them via `/implement`, and prepares a new round on the same UAT issue.

While a UAT is pending the pipeline does not touch the hardware. Fixing UAT findings runs hardware tests again, which
replaces the installed build — reinstall it for the next round as described in the instructions.

## Install a build for testing
```sh
git switch main && git pull --ff-only
git checkout <build commit from the UAT doc>
npm ci && npm run build
scripts/homey-run.sh stop --uninstall   # removes a dev build the pipeline may still keep installed
homey app install          # installs persistently on the selected Homey (agents never do this)
git switch main
```

## Template for `docs/uat/v<version>.md`
```markdown
# UAT v<version>: <milestone name>

**Status:** pending (round 1) | accepted YYYY-MM-DD | rejected round N → bugs #…
**Build:** `main` @ `<sha>` · **UAT issue:** #<n> · **Issues:** #… #…

## Preconditions
- Build installed (see docs/uat/README.md), TimeBox Evo switched on, within Bluetooth range of the Homey.
- <device paired / previous state needed, Homey language for locale checks, …>

## Test cases
### UAT-1 <title> (#<issue>) [auto]
1. <step in the Homey app: device tile / device settings / Flow editor>
2. …
**Expected:** <exact result on the Evo display and in the Homey app>

### UAT-2 …

## Edge cases
### UAT-n Device unreachable
…

## Regression smoke (accepted milestones)
- <one line per earlier feature, with expected result>

## Rounds
| Round | Date | Result | Failing cases | Bugs |
|---|---|---|---|---|
```

## Active
None.

## Archive
Accepted UAT docs are kept in `docs/uat/archive/` (moved there after acceptance, #120):
- [archive/v0.2.0.md](archive/v0.2.0.md)
- [archive/v0.3.0.md](archive/v0.3.0.md)
- [archive/v0.4.0.md](archive/v0.4.0.md)
- [archive/v0.5.0.md](archive/v0.5.0.md)
- [archive/v1.0.0.md](archive/v1.0.0.md)
- [archive/v1.1.0.md](archive/v1.1.0.md)
