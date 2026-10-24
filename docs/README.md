# Documentation index

> **History note.** This repository starts with a single commit at v1.1.0 (2026-10-24). Issue and PR numbers mentioned
> for work up to v1.1.0 (milestones 0.2.0 to 1.1.0, ADRs, `docs/uat/archive/`, protocol evidence) refer to the earlier
> private development repository. From milestone 1.2.0 on, numbers refer to this repository: the open issues were
> recreated here as #1 (was #158), #2 (#168), #3 (#169), #4 (#34), #5 (#29), #6 (#35) and #7 (#96).

| Doc | Purpose |
|---|---|
| [project-requirements.md](project-requirements.md) | Refined repo/process requirements (source of truth for the setup) |
| [pipeline.md](pipeline.md) | Agent pipeline in GitHub Actions: owner commands, workflows, security model, runner check, hardware testing |
| [conventions.md](conventions.md) | Coding, branching, commit, test conventions |
| [architecture.md](architecture.md) | App architecture overview (living document): layers, data flow, module status, layout |
| [architecture/](architecture.md#areas) | Area files with the detail per topic (transport, pairing, device, modes, clock, text, weather, store assets, ...); the overview lists them |
| [divoom-protocol.md](divoom-protocol.md) | Timebox Evo Bluetooth protocol reference: opcode tables, status labels, section numbers |
| [protocol/](divoom-protocol.md#evidence-files) | Evidence files for the protocol reference (probe logs, measurements, long notes) |
| [roadmap.md](roadmap.md) | Milestones, issues and design principles of the rebuild |
| [versioning.md](versioning.md) | SemVer rules, release mechanics and the release procedure (`npm run release:check` / `release:bump`) |
| [release-checklist.md](release-checklist.md) | App Store release checklist (agent and owner items) and the 1.0.0 status |
| [testing/stability.md](testing/stability.md) | Stability test (#36): how to run the soak, scenarios S0-S8, criteria C1-C6, owner manual cases M1-M6, results |
| [uat/](uat/README.md) | Owner acceptance tests per milestone: process, template, test instructions per version (no active UAT; accepted ones in `uat/archive/`, see its Archive section) |
| [archive/breaking-changes.md](archive/breaking-changes.md) | Breaking-change lists of released versions (0.3.0 to 1.0.0) |
| [decisions/](decisions/) | Architecture Decision Records (ADRs), listed below |

## ADRs

| ADR | Topic | Status |
|---|---|---|
| [0001](decisions/0001-agentic-pipeline.md) | Label-driven GitHub Actions pipeline | superseded by 0003 |
| [0002](decisions/0002-transport.md) | Transport: direct BLE | accepted |
| [0003](decisions/0003-local-agent-workflow.md) | Local agent workflow | superseded by 0011 |
| [0004](decisions/0004-text-as-images.md) | Text rendered in software | superseded by 0005 |
| [0005](decisions/0005-rebuild-on-verified-protocol.md) | Rebuild on the verified protocol | accepted |
| [0006](decisions/0006-autonomous-pipeline.md) | Autonomous pipeline with hardware tests | accepted, amended by 0007 and 0011 |
| [0007](decisions/0007-owner-acceptance-per-milestone.md) | Owner acceptance test per milestone | accepted |
| [0008](decisions/0008-native-text-overlay.md) | Native text as an overlay, not a mode | accepted |
| [0009](decisions/0009-pure-js-image-decoding.md) | Pure-JS image decoding for the Show image actions | accepted, amended by 0010 |
| [0010](decisions/0010-bounded-memory-image-decoding.md) | Bounded-memory image decoding | accepted |
| [0011](decisions/0011-actions-pipeline-public-repo.md) | Agent pipeline in GitHub Actions for a public repository | accepted |
