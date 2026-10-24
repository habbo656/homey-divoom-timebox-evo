// Tests for scripts/homey-run.sh argument handling (#94). Only side-effect-free paths run; a stub `homey` records any call.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'homey-run.sh');

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function run(args) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'homey-run-test-'));
  dirs.push(root);
  const tmp = path.join(root, 'tmp');
  const stub = path.join(root, 'bin');
  const marker = path.join(root, 'homey-called');
  fs.mkdirSync(tmp);
  fs.mkdirSync(stub);
  fs.writeFileSync(path.join(stub, 'homey'), `#!/bin/sh\necho "$@" >> '${marker}'\nexit 1\n`, { mode: 0o755 });
  const res = spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, TMPDIR: tmp, PATH: `${stub}${path.delimiter}${process.env.PATH}` },
  });
  return {
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
    homeyCalled: fs.existsSync(marker),
    state: fs.existsSync(path.join(tmp, 'divoom-hw')),
    lock: fs.existsSync(path.join(tmp, 'divoom-hw', 'lock')),
  };
}

describe('homey-run.sh usage (#94)', () => {
  it.each([[[]], [['-h']], [['--help']], [['help']], [['foo']], [['run', 'abc']]])(
    'prints the usage and exits 2 without starting a run: %j',
    (args) => {
      const res = run(args);
      expect(res.status).toBe(2);
      expect(res.stderr).toContain('homey-run.sh start');
      expect(res.stderr).toContain('Exit codes');
      expect(res.homeyCalled).toBe(false);
      expect(res.state).toBe(false);
      expect(res.lock).toBe(false);
    },
  );

  it('names an unknown command', () => {
    expect(run(['foo']).stderr).toContain("unknown command 'foo'");
  });

  it('status reports no build without side effects', () => {
    const res = run(['status']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('HOMEY-RUN: no build running');
    expect(res.homeyCalled).toBe(false);
  });

  it('log without a log file says so', () => {
    const res = run(['log']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('HOMEY-RUN: no log yet');
    expect(res.homeyCalled).toBe(false);
    expect(res.lock).toBe(false);
  });
});
