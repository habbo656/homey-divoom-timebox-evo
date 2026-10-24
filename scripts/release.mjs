#!/usr/bin/env node
// Release tooling (#38): `check` verifies that every version in the repository agrees, `bump` changes them all.
// Procedure: docs/versioning.md#release-procedure.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyBump, checkConsistency, planBump } from './release/version.mjs';

const USAGE = `Usage:
  node scripts/release.mjs check [--root <dir>]
  node scripts/release.mjs bump <major|minor|patch|X.Y.Z> --en <text> --de <text> [--note <text>] [--dry-run]

Options (bump): --en/--de changelog texts (required), --note text in parentheses on the README version line,
--dry-run print the changes and write nothing, --root <dir> repository root (default: this repository).`;

/** @param {string} message */
function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

/**
 * Options with a value are `--en`, `--de`, `--note` and `--root`; `flags` are boolean options.
 * @param {string[]} args @param {string[]} valueOptions @param {string[]} flags
 */
function parseArgs(args, valueOptions, flags) {
  const values = /** @type {Record<string, string>} */ ({});
  const given = /** @type {string[]} */ ([]);
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) positional.push(arg);
    else if (given.includes(arg)) fail(`${arg} given twice\n${USAGE}`);
    else if (flags.includes(arg)) given.push(arg);
    else if (valueOptions.includes(arg)) {
      if (i + 1 >= args.length || args[i + 1].startsWith('--')) fail(`${arg} needs a value\n${USAGE}`);
      given.push(arg);
      values[arg.slice(2)] = args[++i];
    } else fail(`unknown option ${arg}\n${USAGE}`);
  }
  return { positional, values, dryRun: given.includes('--dry-run') };
}

const [command, ...rest] = process.argv.slice(2);
const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** @param {Record<string, string>} values */
const rootOf = (values) => (values.root ? path.resolve(values.root) : defaultRoot);

if (command === 'check') {
  const { positional, values } = parseArgs(rest, ['--root'], []);
  if (positional.length) fail(`check takes no arguments, got ${positional.join(' ')}\n${USAGE}`);
  const errors = checkConsistency(rootOf(values));
  if (errors.length) fail(`version check failed:\n  ${errors.join('\n  ')}`);
  console.log('release check: all versions are consistent');
} else if (command === 'bump') {
  const { positional, values, dryRun } = parseArgs(rest, ['--en', '--de', '--note', '--root'], ['--dry-run']);
  if (positional.length !== 1) fail(`bump needs exactly one of major, minor, patch or X.Y.Z\n${USAGE}`);
  const spec = positional[0];
  const root = rootOf(values);
  try {
    const plan = planBump(root, spec, { en: values.en ?? '', de: values.de ?? '', note: values.note });
    console.log(dryRun ? `Dry run, nothing written. Would bump to ${plan.version}:` : `Bumping to ${plan.version}:`);
    for (const { file, before, after } of plan.changes) console.log(`  ${file}: ${before} -> ${after}`);
    console.log(`  changelog entry ${plan.version}: ${JSON.stringify(plan.entry)}`);
    if (!dryRun) applyBump(root, plan);
  } catch (error) {
    fail(/** @type {Error} */ (error).message);
  }
} else {
  fail(`unknown command ${JSON.stringify(command)}\n${USAGE}`);
}
