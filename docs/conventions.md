# Conventions

- **Language:** English everywhere. Exception: German locale texts (`locales/de.json`, German labels in compose files) are
  UTF-8 with proper umlauts and ß (ä, ö, ü, ß), never ae/oe/ue/ss transliterations.
- **Stack:** Homey SDK v3, TypeScript (strict), Homey Compose (`.homeycompose/`), ESLint, Prettier, Node LTS.
- **Branches:** `agent/issue-<n>-<slug>` for agent work; merge to `main` via PR (squash), done by the pipeline once all
  local gates pass (`docs/pipeline.md`).
- **Formatting:** Prettier (`.prettierrc.json`: `printWidth` 120, single quotes, other options at the Prettier 3
  defaults; version pinned exactly in `package.json`) formats code only (`.ts`, `.mjs`); `.prettierignore` excludes
  Markdown, JSON, YAML, HTML and generated files. Run `npm run format` before committing; `npm run format:check`
  (part of `scripts/gate.sh`) fails on unformatted code. A purely mechanical reformat is committed on its own as
  `style:` (output of `npm run format` only, no manual edits).
- **Local scratch output:** `.hwtest/` is local hardware-test scratch output (gitignored) and is excluded from ESLint
  (`eslint.config.mjs`) and Prettier (`.prettierignore`), so scratch scripts there never affect `scripts/gate.sh`. The
  installed protocol KB skill `.claude/skills/divoom-evo/` (gitignored) is excluded from ESLint for the same reason.
- **Commits:** Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `test:`, `style:`), reference `#<n>`.
- **PRs:** one issue per PR, body contains `Closes #<n>`, summary, test evidence, doc changes.
- **Tests:** unit tests for protocol encoding/decoding without hardware; hardware-dependent
  behaviour is isolated behind an interface so it can be mocked.
- **User-visible errors:** every error a user can see is localised (en + de). Input validation in device parsers throws
  `ArgumentError` (`src/device/argumentError.ts`); the Homey layer turns it into the localised message with `localiseError`.
  Protocol `RangeError`s are a backstop and never the user-facing path.
- **Docs:** update the architecture overview and area files (`docs/architecture.md`, `docs/architecture/`) / the protocol reference and evidence files (`docs/divoom-protocol.md`, `docs/protocol/`) with every relevant change.
- **Decisions:** significant choices get an ADR in `docs/decisions/NNNN-title.md`.
