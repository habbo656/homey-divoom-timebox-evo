// Tests for scripts/release/version.mjs and scripts/release.mjs (#38). Fixtures are copies of the real files.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { applyBump, checkConsistency, nextVersion, planBump, readVersions } from './version.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILES = [
  '.homeycompose/app.json',
  'app.json',
  'package.json',
  'package-lock.json',
  '.homeychangelog.json',
  'README.md',
];
const TEXT = { en: 'English text', de: 'Deutscher Text', note: 'test' };

const dirs = [];
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-test-'));
  dirs.push(dir);
  for (const file of FILES) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.copyFileSync(path.join(repo, file), path.join(dir, file));
  }
  return dir;
}
const read = (dir, file) => fs.readFileSync(path.join(dir, file), 'utf8');
const write = (dir, file, text) => fs.writeFileSync(path.join(dir, file), text);
const edit = (dir, file, fn) => write(dir, file, fn(read(dir, file)));
const snapshot = (dir) => Object.fromEntries(FILES.map((file) => [file, read(dir, file)]));
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

const current = readVersions(repo).compose;
const bumped = (spec) => nextVersion(current, spec);

describe('release check (C)', () => {
  it('C1: the real repository is consistent', () => {
    expect(checkConsistency(repo)).toEqual([]);
    const v = readVersions(repo);
    expect(new Set([v.compose, v.app, v.pkg, v.lockRoot, v.lockPkg, v.readme]).size).toBe(1);
  });

  it('C2: reports one error per mismatching place', () => {
    const cases = [
      ['package.json', (t) => t.replace(`"version": "${current}"`, '"version": "9.9.9"'), 'package.json'],
      [
        'package-lock.json',
        (t) => t.replace(`"version": "${current}"`, '"version": "9.9.9"'),
        'package-lock.json: version is "9.9.9"',
      ],
      [
        'package-lock.json',
        (t) => {
          const first = t.indexOf(`"version": "${current}"`);
          const second = t.indexOf(`"version": "${current}"`, first + 1);
          return t.slice(0, second) + '"version": "9.9.9"' + t.slice(second + `"version": "${current}"`.length);
        },
        'packages[""].version is "9.9.9"',
      ],
      ['app.json', (t) => t.replace(`"version": "${current}"`, '"version": "9.9.9"'), 'app.json: version is "9.9.9"'],
      ['README.md', (t) => t.replace(/> Current version: \S+/, '> Current version: 9.9.9'), 'README.md'],
      ['README.md', (t) => t.replace(/^> Current version:.*$/m, '> Version 1'), 'README.md'],
    ];
    for (const [file, change, expected] of cases) {
      const dir = fixture();
      edit(dir, file, change);
      const errors = checkConsistency(dir);
      expect(errors, `${file} ${expected}`).toHaveLength(1);
      expect(errors[0]).toContain(expected);
    }
  });

  it('C2: names the expected README line', () => {
    const dir = fixture();
    edit(dir, 'README.md', (t) => t.replace(/^> Current version:.*$/m, '> Version 1'));
    expect(checkConsistency(dir)[0]).toContain(`> Current version: ${current}`);
  });

  it('C2: requires exactly one README version line', () => {
    const dir = fixture();
    edit(dir, 'README.md', (t) => t + '\n> Current version: ' + current + '. Changelog: `.homeychangelog.json`.\n');
    const errors = checkConsistency(dir);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('README.md');
  });

  it('C2: reports a manifest version that differs from the generated app.json', () => {
    const dir = fixture();
    edit(dir, '.homeycompose/app.json', (t) => t.replace(`"version": "${current}"`, '"version": "9.9.9"'));
    const errors = checkConsistency(dir);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join('\n')).toContain('app.json: version is');
  });

  it('C3: reports a missing changelog entry and a newer changelog key', () => {
    const missing = fixture();
    const changelog = JSON.parse(read(missing, '.homeychangelog.json'));
    delete changelog[current];
    write(missing, '.homeychangelog.json', JSON.stringify(changelog, null, 2) + '\n');
    const errors = checkConsistency(missing);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`no entry for version ${current}`);

    const newer = fixture();
    const c2 = JSON.parse(read(newer, '.homeychangelog.json'));
    c2['9.0.0'] = { en: 'x', de: 'y' };
    write(newer, '.homeychangelog.json', JSON.stringify(c2, null, 2) + '\n');
    const errors2 = checkConsistency(newer);
    expect(errors2).toHaveLength(1);
    expect(errors2[0]).toContain('9.0.0 is newer');
  });
});

describe('next version (N)', () => {
  it('N1: major, minor, patch and explicit versions', () => {
    expect(nextVersion('0.5.0', 'patch')).toBe('0.5.1');
    expect(nextVersion('0.5.0', 'minor')).toBe('0.6.0');
    expect(nextVersion('0.5.0', 'major')).toBe('1.0.0');
    expect(nextVersion('0.5.0', '1.0.0')).toBe('1.0.0');
    expect(nextVersion('0.5.0', '0.5.1')).toBe('0.5.1');
  });

  it('N1: rejects the current, a lower, a pre-release and a non-version', () => {
    for (const spec of ['0.5.0', '0.4.9', '1.0.0-beta', '1.0', 'x', '', '01.0.0', 'v1.0.0']) {
      expect(() => nextVersion('0.5.0', spec), spec).toThrow();
    }
  });
});

describe('bump (B)', () => {
  it('B1: an explicit major bump leaves the check green and changes only the expected lines', () => {
    const dir = fixture();
    const before = snapshot(dir);
    const target = bumped('major');
    const plan = planBump(dir, target, TEXT);
    expect(plan.version).toBe(target);
    applyBump(dir, plan);
    expect(checkConsistency(dir)).toEqual([]);
    expect(readVersions(dir).compose).toBe(target);

    const expectedLines = {
      '.homeycompose/app.json': 1,
      'app.json': 1,
      'package.json': 1,
      'package-lock.json': 2,
      'README.md': 1,
    };
    for (const [file, count] of Object.entries(expectedLines)) {
      const [b, a] = [before[file].split('\n'), read(dir, file).split('\n')];
      expect(a.length, file).toBe(b.length);
      const changed = a.map((line, i) => [b[i], line]).filter(([x, y]) => x !== y);
      expect(changed, file).toHaveLength(count);
      if (file === 'README.md') {
        expect(changed[0][1]).toBe(`> Current version: ${target} (test). Changelog: \`.homeychangelog.json\`.`);
      } else {
        for (const [x, y] of changed) {
          expect(x).toContain(`"version": "${current}"`);
          expect(y).toBe(x.replace(current, target));
        }
      }
    }

    const changelogBefore = JSON.parse(before['.homeychangelog.json']);
    const changelogAfter = JSON.parse(read(dir, '.homeychangelog.json'));
    expect(Object.keys(changelogAfter)).toEqual([...Object.keys(changelogBefore), target]);
    expect(changelogAfter[target]).toEqual({ en: TEXT.en, de: TEXT.de });
    const head = before['.homeychangelog.json'].replace(/\n {2}\}\n\}\n$/, '');
    expect(read(dir, '.homeychangelog.json').startsWith(head)).toBe(true);
    expect(read(dir, '.homeychangelog.json').endsWith('\n')).toBe(true);
  });

  it('B1: the README line has no parentheses without a note', () => {
    const dir = fixture();
    applyBump(dir, planBump(dir, 'patch', { en: 'a', de: 'b' }));
    expect(read(dir, 'README.md')).toContain(
      `> Current version: ${bumped('patch')}. Changelog: \`.homeychangelog.json\`.`,
    );
    expect(checkConsistency(dir)).toEqual([]);
  });

  it('B1: a bump can follow a bump', () => {
    const dir = fixture();
    applyBump(dir, planBump(dir, 'patch', TEXT));
    applyBump(dir, planBump(dir, 'minor', TEXT));
    expect(readVersions(dir).compose).toBe(bumped('minor'));
    expect(checkConsistency(dir)).toEqual([]);
  });

  it('B2: rejects empty texts, an existing key and an inconsistent start', () => {
    const dir = fixture();
    const before = snapshot(dir);
    expect(() => planBump(dir, 'patch', { en: 'a', de: '  ' })).toThrow(/German/);
    expect(() => planBump(dir, 'patch', { en: '', de: 'b' })).toThrow(/English/);
    expect(() => planBump(dir, 'patch', { en: 'a', de: 'b', note: 'bad (note)' })).toThrow(/note/);
    expect(() => planBump(dir, '0.1.0', TEXT)).toThrow(/not greater/);

    const withKey = fixture();
    // A changelog key for the target version without bumping the app: the check reports it as newer.
    const changelog = JSON.parse(read(withKey, '.homeychangelog.json'));
    changelog[bumped('patch')] = { en: 'x', de: 'y' };
    write(withKey, '.homeychangelog.json', JSON.stringify(changelog, null, 2) + '\n');
    expect(() => planBump(withKey, 'patch', TEXT)).toThrow(/newer|already exists/);

    const broken = fixture();
    edit(broken, 'package.json', (t) => t.replace(`"version": "${current}"`, '"version": "9.9.9"'));
    const brokenBefore = snapshot(broken);
    expect(() => planBump(broken, 'patch', TEXT)).toThrow(/inconsistent/);
    expect(snapshot(broken)).toEqual(brokenBefore);
    expect(snapshot(dir)).toEqual(before);
  });

  it('B3: planning (dry run) does not touch any file', () => {
    const dir = fixture();
    const before = snapshot(dir);
    const plan = planBump(dir, 'major', TEXT);
    expect(plan.changes.length).toBeGreaterThan(5);
    expect(snapshot(dir)).toEqual(before);
  });

  const run = (...args) =>
    spawnSync(process.execPath, [path.join(repo, 'scripts', 'release.mjs'), ...args], { encoding: 'utf8' });

  it('B3: the CLI dry run prints the changes, exits 0 and writes nothing', () => {
    const dir = fixture();
    const before = snapshot(dir);
    const result = run('bump', 'patch', '--en', 'a', '--de', 'b', '--dry-run', '--root', dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`package.json (version): ${current} -> ${bumped('patch')}`);
    expect(result.stdout).toContain('changelog entry');
    expect(snapshot(dir)).toEqual(before);
  });

  it('B3: the CLI bump writes the files and leaves the check green', () => {
    const dir = fixture();
    const result = run('bump', 'patch', '--en', 'a', '--de', 'b', '--root', dir);
    expect(result.status).toBe(0);
    expect(readVersions(dir).compose).toBe(bumped('patch'));
    expect(run('check', '--root', dir).status).toBe(0);
  });

  it('B3: the CLI rejects bad arguments and writes nothing', () => {
    const dir = fixture();
    const before = snapshot(dir);
    const bad = [
      ['bump', 'patch', '--en', 'a', '--root', dir],
      ['bump', 'patch', '--en', '--dry-run', '--de', 'x', '--root', dir],
      ['bump', 'patch', '--en', 'a', '--de', 'b', '--note', '--dry-run', '--root', dir],
      ['bump', 'patch', '--en', 'a', '--de', 'b', '--root'],
      ['bump', 'patch', '--en', 'a', '--en', 'c', '--de', 'b', '--root', dir],
      ['bump', 'patch', '--en', 'a', '--de', 'b', '--dry-run', '--dry-run', '--root', dir],
      ['bump', 'patch', 'minor', '--en', 'a', '--de', 'b', '--root', dir],
      ['bump', '--en', 'a', '--de', 'b', '--root', dir],
      ['bump', 'patch', '--en', 'a', '--de', 'b', '--bogus', '--root', dir],
      ['check', 'extra', '--root', dir],
      ['check', '--bogus', '--root', dir],
      ['check', '--root', path.join(dir, 'missing')],
      ['frobnicate'],
    ];
    for (const args of bad) {
      expect(run(...args).status, args.join(' ')).toBe(1);
      expect(snapshot(dir), args.join(' ')).toEqual(before);
    }
  });

  it('B3: the CLI check follows the fixture', () => {
    const dir = fixture();
    expect(run('check', '--root', dir).status).toBe(0);
    edit(dir, 'package.json', (t) => t.replace(`"version": "${current}"`, '"version": "9.9.9"'));
    const broken = run('check', '--root', dir);
    expect(broken.status).toBe(1);
    expect(broken.stderr).toContain('package.json');
  });

  it('B4: an unexpected lock file layout aborts without writing', () => {
    const dir = fixture();
    // An entry that carries the current version before packages[""] takes the second text replacement.
    edit(dir, 'package-lock.json', (t) =>
      t.replace('"packages": {', `"packages": {\n    "node_modules/x": { "version": "${current}" },`),
    );
    expect(checkConsistency(dir)).toEqual([]);
    const before = snapshot(dir);
    expect(() => planBump(dir, 'patch', TEXT)).toThrow(/package-lock\.json: unexpected layout/);
    expect(snapshot(dir)).toEqual(before);
  });

  it('B4: a non-canonical changelog layout aborts without writing', () => {
    const dir = fixture();
    edit(dir, '.homeychangelog.json', (t) => t.replace(/\n$/, '\n\n'));
    const before = snapshot(dir);
    expect(() => planBump(dir, 'patch', TEXT)).toThrow(/canonical/);
    expect(snapshot(dir)).toEqual(before);
  });
});
