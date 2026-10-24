// Release version handling (#38): consistency check and bump of every place that carries the app version.
// Pure Node, no dependencies. The CLI is scripts/release.mjs; the procedure is docs/versioning.md.
//
// The manifests do not survive a JSON.stringify round trip (compact arrays and objects), so versions are replaced
// by text. Every new text is parsed and deep-compared against the parsed original with only the version fields
// changed before anything is written.
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export const COMPOSE_FILE = '.homeycompose/app.json';
export const APP_FILE = 'app.json';
export const PKG_FILE = 'package.json';
export const LOCK_FILE = 'package-lock.json';
export const CHANGELOG_FILE = '.homeychangelog.json';
export const README_FILE = 'README.md';

const PLAIN_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
// `> Current version: X.Y.Z[ (<note>)]. Changelog: `.homeychangelog.json`.`
const README_LINE = /^> Current version: (\S+?)(?: \(([^()\n]*)\))?\. Changelog: `\.homeychangelog\.json`\.$/m;
const README_LINE_ANY = /^> Current version: .*$/gm;

/**
 * @typedef {{ en: string, de: string, note?: string }} ReleaseText
 * @typedef {{ file: string, before: string, after: string }} Change
 * @typedef {{ file: string, content: string }} Write
 * @typedef {{ version: string, changes: Change[], writes: Write[], entry: { en: string, de: string } }} BumpPlan
 * @typedef {{
 *   compose: string | undefined, app: string | undefined, pkg: string | undefined,
 *   lockRoot: string | undefined, lockPkg: string | undefined,
 *   readme: string | undefined, changelogKeys: string[] | undefined,
 * }} Versions
 */

/** @param {string} version @returns {number[]} */
const parts = (version) => version.split('.').map(Number);

/** Negative, zero or positive like a comparator, for plain X.Y.Z versions. @param {string} a @param {string} b */
export function compareVersions(a, b) {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** @param {string} root @param {string} file @returns {string} */
const readText = (root, file) => fs.readFileSync(path.join(root, file), 'utf8');

/** @template T @param {() => T} read @returns {T | undefined} */
function attempt(read) {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/** @param {string} root @param {string} file @returns {any} parsed JSON or undefined */
const readJson = (root, file) => attempt(() => JSON.parse(readText(root, file)));

/** Version carried by the README line, or undefined when there is not exactly one well-formed line. @param {string} text */
function readmeLine(text) {
  if ((text.match(README_LINE_ANY) ?? []).length !== 1) return undefined;
  const match = README_LINE.exec(text);
  return match ? { version: match[1], note: match[2] } : undefined;
}

/**
 * Every version found in the repository files; a field is undefined when its file or value is missing.
 * @param {string} root repository root
 * @returns {Versions}
 */
export function readVersions(root) {
  const lock = readJson(root, LOCK_FILE);
  const changelog = readJson(root, CHANGELOG_FILE);
  const readme = attempt(() => readmeLine(readText(root, README_FILE)));
  return {
    compose: readJson(root, COMPOSE_FILE)?.version,
    app: readJson(root, APP_FILE)?.version,
    pkg: readJson(root, PKG_FILE)?.version,
    lockRoot: lock?.version,
    lockPkg: lock?.packages?.['']?.version,
    readme: readme?.version,
    changelogKeys: changelog && typeof changelog === 'object' ? Object.keys(changelog) : undefined,
  };
}

/**
 * Consistency check; every error names the file and the offending value.
 * @param {string} root repository root
 * @returns {string[]} errors, empty when consistent
 */
export function checkConsistency(root) {
  const v = readVersions(root);
  /** @type {string[]} */
  const errors = [];
  const expected = v.compose;
  if (typeof expected !== 'string' || !PLAIN_VERSION.test(expected)) {
    return [`${COMPOSE_FILE}: version is ${JSON.stringify(expected)}, expected a plain X.Y.Z version`];
  }
  /** @type {[string, string, string | undefined][]} */
  const others = [
    [APP_FILE, 'version', v.app],
    [PKG_FILE, 'version', v.pkg],
    [LOCK_FILE, 'version', v.lockRoot],
    [LOCK_FILE, 'packages[""].version', v.lockPkg],
  ];
  for (const [file, field, value] of others) {
    if (value !== expected) {
      errors.push(
        `${file}: ${field} is ${JSON.stringify(value)}, expected ${JSON.stringify(expected)} (${COMPOSE_FILE})`,
      );
    }
  }
  if (v.readme !== expected) {
    errors.push(
      `${README_FILE}: the "Current version" line says ${JSON.stringify(v.readme)}, expected the line ` +
        `"> Current version: ${expected}[ (<note>)]. Changelog: \`.homeychangelog.json\`."`,
    );
  }
  if (!v.changelogKeys) {
    errors.push(`${CHANGELOG_FILE}: missing or not a JSON object`);
  } else {
    if (!v.changelogKeys.includes(expected)) {
      errors.push(`${CHANGELOG_FILE}: no entry for version ${expected} (${COMPOSE_FILE})`);
    }
    for (const key of v.changelogKeys) {
      if (PLAIN_VERSION.test(key) && compareVersions(key, expected) > 0) {
        errors.push(`${CHANGELOG_FILE}: entry ${key} is newer than the app version ${expected} (${COMPOSE_FILE})`);
      }
    }
  }
  return errors;
}

/**
 * The version a bump leads to.
 * @param {string} current plain X.Y.Z
 * @param {string} spec 'major' | 'minor' | 'patch' | plain X.Y.Z greater than current
 * @returns {string}
 */
export function nextVersion(current, spec) {
  if (!PLAIN_VERSION.test(current)) throw new Error(`current version ${JSON.stringify(current)} is not a plain X.Y.Z`);
  const [major, minor, patch] = parts(current);
  if (spec === 'major') return `${major + 1}.0.0`;
  if (spec === 'minor') return `${major}.${minor + 1}.0`;
  if (spec === 'patch') return `${major}.${minor}.${patch + 1}`;
  if (!PLAIN_VERSION.test(spec)) {
    throw new Error(
      `${JSON.stringify(spec)} is not major, minor, patch or a plain X.Y.Z version (no pre-release suffix)`,
    );
  }
  if (compareVersions(spec, current) <= 0)
    throw new Error(`version ${spec} is not greater than the current ${current}`);
  return spec;
}

/**
 * Replace the first `count` `"version": "<from>"` values by text.
 * @param {string} text @param {string} from @param {string} to @param {number} count @param {string} file
 */
function replaceVersions(text, from, to, count, file) {
  const pattern = new RegExp(`("version"\\s*:\\s*")${from.replace(/\./g, '\\.')}(")`);
  let result = text;
  let offset = 0;
  for (let i = 0; i < count; i++) {
    const match = pattern.exec(result.slice(offset));
    if (!match) throw new Error(`${file}: expected ${count} "version": "${from}" values, found ${i}`);
    const start = offset + match.index + match[1].length;
    result = result.slice(0, start) + to + result.slice(start + from.length);
    offset = start + to.length;
  }
  return result;
}

/**
 * Text of `file` with the version fields changed, verified by parse and deep compare.
 * @param {string} root @param {string} file @param {string} from @param {string} to
 * @param {(json: any, version: string) => void} setVersions sets every version field of the parsed JSON
 * @param {number} count how many `"version"` values change
 */
function bumpedJson(root, file, from, to, setVersions, count) {
  const before = readText(root, file);
  const after = replaceVersions(before, from, to, count, file);
  const expected = JSON.parse(before);
  setVersions(expected, to);
  let actual;
  try {
    actual = JSON.parse(after);
  } catch (error) {
    throw new Error(`${file}: result is not valid JSON, nothing written (${/** @type {Error} */ (error).message})`);
  }
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`${file}: unexpected layout, the edit would change more than the version fields, nothing written`);
  }
  return after;
}

/**
 * Everything a bump changes, computed and verified in memory; nothing is written.
 * @param {string} root repository root
 * @param {string} spec 'major' | 'minor' | 'patch' | plain X.Y.Z
 * @param {ReleaseText} text changelog texts and optional README note
 * @returns {BumpPlan}
 */
export function planBump(root, spec, text) {
  const errors = checkConsistency(root);
  if (errors.length) throw new Error(`versions are inconsistent, fix them first:\n  ${errors.join('\n  ')}`);
  const current = /** @type {string} */ (readVersions(root).compose);
  const version = nextVersion(current, spec);
  const en = (text.en ?? '').trim();
  const de = (text.de ?? '').trim();
  if (!en) throw new Error('the English changelog text (--en) must not be empty');
  if (!de) throw new Error('the German changelog text (--de) must not be empty');
  const note = (text.note ?? '').trim();
  if (/[()\n\r]/.test(note)) throw new Error('the note must be one line without parentheses');

  /** @type {Write[]} */
  const writes = [];
  /** @type {Change[]} */
  const changes = [];
  /** @param {string} file @param {string} content @param {Change[]} list */
  const add = (file, content, list) => {
    writes.push({ file, content });
    changes.push(...list);
  };
  /** @param {string} file @param {string} [field] @returns {Change} */
  const change = (file, field = 'version') => ({ file: `${file} (${field})`, before: current, after: version });

  const setTop = (/** @type {any} */ json, /** @type {string} */ v) => (json.version = v);
  add(COMPOSE_FILE, bumpedJson(root, COMPOSE_FILE, current, version, setTop, 1), [change(COMPOSE_FILE)]);
  add(APP_FILE, bumpedJson(root, APP_FILE, current, version, setTop, 1), [change(APP_FILE)]);
  add(PKG_FILE, bumpedJson(root, PKG_FILE, current, version, setTop, 1), [change(PKG_FILE)]);
  add(
    LOCK_FILE,
    bumpedJson(
      root,
      LOCK_FILE,
      current,
      version,
      (json, v) => {
        json.version = v;
        json.packages[''].version = v;
      },
      2,
    ),
    [change(LOCK_FILE), change(LOCK_FILE, 'packages[""].version')],
  );

  // README line
  const readme = readText(root, README_FILE);
  const lines = readme.match(README_LINE_ANY) ?? [];
  if (lines.length !== 1)
    throw new Error(`${README_FILE}: expected exactly one "> Current version:" line, found ${lines.length}`);
  const line = `> Current version: ${version}${note ? ` (${note})` : ''}. Changelog: \`.homeychangelog.json\`.`;
  add(
    README_FILE,
    readme.replace(README_LINE_ANY, () => line),
    [{ file: README_FILE, before: lines[0], after: line }],
  );

  // Changelog: the file round-trips through JSON.stringify, which is verified, then the entry is appended last.
  const changelogText = readText(root, CHANGELOG_FILE);
  const changelog = JSON.parse(changelogText);
  if (JSON.stringify(changelog, null, 2) + '\n' !== changelogText) {
    throw new Error(`${CHANGELOG_FILE}: not in canonical JSON.stringify(…, null, 2) layout, nothing written`);
  }
  if (Object.hasOwn(changelog, version)) throw new Error(`${CHANGELOG_FILE}: entry ${version} already exists`);
  const entry = { en, de };
  changelog[version] = entry;
  add(CHANGELOG_FILE, JSON.stringify(changelog, null, 2) + '\n', [
    { file: CHANGELOG_FILE, before: '(no entry)', after: `entry ${version}` },
  ]);

  return { version, changes, writes, entry };
}

/**
 * Write a verified plan. All new contents exist already, so a failure here can only be an I/O error; a partial write
 * is caught by `release:check` and restorable with git.
 * @param {string} root @param {BumpPlan} plan
 */
export function applyBump(root, plan) {
  for (const { file, content } of plan.writes) fs.writeFileSync(path.join(root, file), content);
}
