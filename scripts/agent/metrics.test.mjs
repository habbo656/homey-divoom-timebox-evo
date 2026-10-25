// Tests for scripts/agent/metrics.py (record build + schema validation) and scripts/agent/pages-publish.sh (#24).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const metrics = path.join(here, 'metrics.py');

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-test-'));
  dirs.push(dir);
  return dir;
}

function py(args) {
  return spawnSync('python3', [metrics, ...args], { encoding: 'utf8', timeout: 20000 });
}

const stage = (over = {}) => ({
  schema: 1,
  stage: 'develop',
  model: 'claude-sonnet-5-5',
  cli_version: '2.1.308',
  num_turns: 42,
  duration_ms: 600000,
  cost_usd: 1.25,
  input_tokens: 10,
  output_tokens: 2000,
  cache_read_tokens: 300000,
  cache_creation_tokens: 40000,
  subagents: 2,
  models: [
    {
      model: 'claude-sonnet-5-5',
      input_tokens: 10,
      output_tokens: 2000,
      cache_read_tokens: 300000,
      cache_creation_tokens: 40000,
      cost_usd: 1.25,
    },
  ],
  ok: true,
  limited: false,
  subtype: 'success',
  ...over,
});

const ctx = { total: 10, claude_md: 1, agents: 2, prompts: 3, skills: 0, docs: 4 };
const run = (over = {}) => ({
  schema: 1,
  type: 'run',
  run_id: 123456789,
  run_attempt: 1,
  timestamp: 1790000000,
  issue: 24,
  pr: 25,
  round: 1,
  kind: 'issue',
  path: 'develop',
  risk: 'medium',
  size: 'L',
  prompt_commit: '0123456789ab',
  context: ctx,
  stages: [stage()],
  gate: true,
  review: 'approve',
  review_blockers: 0,
  review_majors: 0,
  review_minors: 2,
  hwtest: 'pass',
  status: 'merged',
  ...over,
});

function validate(record) {
  const file = path.join(tmp(), 'r.json');
  fs.writeFileSync(file, JSON.stringify(record));
  return py(['validate', file]);
}

describe('metrics.py validate', () => {
  it('accepts a complete run record and names its file', () => {
    const res = validate(run());
    expect(res.stderr).toBe('');
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe('123456789-1.json');
  });

  it('accepts a uat record', () => {
    const uat = {
      schema: 1,
      type: 'uat',
      run_id: 5,
      run_attempt: 2,
      timestamp: 1790000000,
      issue: 40,
      pr: null,
      milestone: '1.2.0',
      verdict: 'REJECTED',
      rejected: 2,
      prompt_commit: null,
      context: ctx,
      stages: [stage({ stage: 'uat' })],
      gate: null,
      status: 'next-round',
    };
    expect(validate(uat).status).toBe(0);
  });

  it.each([
    ['an unexpected top-level field', run({ note: 'hi' })],
    ['an unexpected stage field', run({ stages: [{ ...stage(), result: 'free text' }] })],
    ['a string outside the enum', run({ status: 'shipped' })],
    ['<script> in a pattern field', run({ stages: [stage({ model: '<script>alert(1)</script>' })] })],
    ['<script> in an enum field', run({ hwtest: '<script>' })],
    ['a trailing newline after a pattern', run({ prompt_commit: '0123456789ab\n' })],
    ['a boolean where an integer belongs', run({ issue: true })],
    ['a float where an integer belongs', run({ round: 1.5 })],
    ['a negative token count', run({ stages: [stage({ output_tokens: -1 })] })],
    [
      'a missing field',
      (() => {
        const r = run();
        delete r.status;
        return r;
      })(),
    ],
    ['an unknown type', run({ type: 'other' })],
    ['too many stages', run({ stages: Array(7).fill(stage()) })],
  ])('rejects %s', (_name, record) => {
    const res = validate(record);
    expect(res.status).toBe(2);
    expect(res.stdout).toBe('');
    expect(res.stderr).not.toContain('<script>');
  });
});

describe('metrics.py run', () => {
  function artifacts(stages) {
    const a = tmp();
    for (const [dir, rec] of Object.entries(stages)) {
      fs.mkdirSync(path.join(a, dir));
      fs.writeFileSync(path.join(a, dir, 'metrics.json'), JSON.stringify(rec));
    }
    return a;
  }

  it('merges valid stage records in stage order and converts the context', () => {
    const a = artifacts({
      review: stage({ stage: 'review' }),
      develop: stage(),
      hwtest: { ...stage({ stage: 'hwtest' }), extra: 1 }, // invalid: left out, the run record stays
    });
    fs.writeFileSync(path.join(a, 'review', 'review.json'), JSON.stringify({ blockers: 1, majors: 2, minors: 3 }));
    const out = path.join(tmp(), 'out.json');
    const res = py([
      'run',
      out,
      a,
      'run_id=77',
      'run_attempt=1',
      'issue=24',
      'pr=',
      'round=2',
      'kind=issue',
      'path=develop',
      'risk=',
      'size=M',
      'gate=false',
      'review=changes_requested',
      'hwtest=',
      'status=next-round',
    ]);
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('left out');
    const rec = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(rec.stages.map((s) => s.stage)).toEqual(['develop', 'review']);
    expect(rec).toMatchObject({
      issue: 24,
      pr: null,
      round: 2,
      risk: null,
      size: 'M',
      gate: false,
      status: 'next-round',
    });
    expect(rec).toMatchObject({ review_blockers: 1, review_majors: 2, review_minors: 3 });
    expect(rec.context.total).toBeGreaterThan(0);
    expect(validate(rec).status).toBe(0);
  });

  it('records a run without any context as failed', () => {
    const out = path.join(tmp(), 'out.json');
    const res = py(['run', out, path.join(tmp(), 'none'), 'run_id=8', 'run_attempt=1']);
    expect(res.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(out, 'utf8'))).toMatchObject({
      issue: null,
      round: 1,
      status: 'failed',
      stages: [],
    });
  });

  it('does not write a record that fails validation', () => {
    const out = path.join(tmp(), 'out.json');
    const res = py(['run', out, tmp(), 'run_id=8', 'run_attempt=1', 'status=<script>']);
    expect(res.status).toBe(2);
    expect(fs.existsSync(out)).toBe(false);
  });
});

describe('pages-publish.sh', () => {
  function git(cwd, ...args) {
    const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
    return res.stdout.trim();
  }

  // A clone of this repository whose origin is a fresh bare repository, so the real scripts and pages/ are used.
  function clone(remote) {
    const repo = path.join(tmp(), 'repo');
    git(path.dirname(remote), 'clone', '-q', remote, repo);
    git(repo, 'config', 'user.name', 'test');
    git(repo, 'config', 'user.email', 'test@example.invalid');
    return repo;
  }

  function setup() {
    const root = path.resolve(here, '../..');
    const remote = path.join(tmp(), 'remote.git');
    git(root, 'init', '-q', '--bare', '-b', 'main', remote);
    const src = path.join(tmp(), 'src');
    fs.mkdirSync(src);
    git(src, 'init', '-q', '-b', 'main');
    for (const f of ['scripts/agent/metrics.py', 'scripts/agent/pages-publish.sh', 'scripts/agent/context-size.sh']) {
      fs.mkdirSync(path.join(src, path.dirname(f)), { recursive: true });
      fs.copyFileSync(path.join(root, f), path.join(src, f));
    }
    fs.mkdirSync(path.join(src, '.github/agent'), { recursive: true });
    fs.copyFileSync(
      path.join(root, '.github/agent/metrics.schema.json'),
      path.join(src, '.github/agent/metrics.schema.json'),
    );
    fs.cpSync(path.join(root, 'pages'), path.join(src, 'pages'), { recursive: true });
    fs.writeFileSync(path.join(src, 'CLAUDE.md'), '# test\n');
    git(src, 'add', '-A');
    git(src, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'init');
    git(src, 'push', '-q', remote, 'main');
    return remote;
  }

  function record(dir, id) {
    const f = path.join(dir, `rec-${id}.json`);
    fs.writeFileSync(f, JSON.stringify(run({ run_id: id })));
    return f;
  }

  function publishIn(repo, rec) {
    return spawnSync('bash', [path.join(repo, 'scripts/agent/pages-publish.sh'), rec], {
      cwd: repo,
      encoding: 'utf8',
      timeout: 60000,
      env: { ...process.env, RUNNER_TEMP: tmp() },
    });
  }

  it('creates gh-pages, then adds records from concurrent clones without losing one', () => {
    const remote = setup();
    const a = clone(remote);
    const b = clone(remote);
    expect(publishIn(a, record(tmp(), 1)).status).toBe(0);
    // b's next push races a's: both start from the same gh-pages head, the loser retries.
    const r2 = spawnSync(
      'bash',
      [
        '-c',
        `(cd "${a}" && RUNNER_TEMP="$3" bash scripts/agent/pages-publish.sh "$1") &
         (cd "${b}" && RUNNER_TEMP="$4" bash scripts/agent/pages-publish.sh "$2"); s=$?; wait $! || s=1; exit $s`,
        '_',
        record(tmp(), 2),
        record(tmp(), 3),
        tmp(),
        tmp(),
      ],
      { encoding: 'utf8', timeout: 120000 },
    );
    expect(r2.status, r2.stderr).toBe(0);
    const check = clone(remote);
    git(check, 'fetch', '-q', 'origin', 'gh-pages');
    git(check, 'switch', '-q', 'gh-pages');
    const index = JSON.parse(fs.readFileSync(path.join(check, 'data/index.json'), 'utf8'));
    expect(index.runs).toEqual(['1-1.json', '2-1.json', '3-1.json']);
    for (const f of ['index.html', 'app.js', 'style.css', '.nojekyll'])
      expect(fs.existsSync(path.join(check, f))).toBe(true);
    expect(git(check, 'ls-files')).not.toContain('scripts/');
  }, 180000);

  it('refuses an invalid record', () => {
    const repo = clone(setup());
    const f = path.join(tmp(), 'bad.json');
    fs.writeFileSync(f, JSON.stringify(run({ status: '<script>' })));
    expect(publishIn(repo, f).status).toBe(2);
    expect(
      spawnSync('git', ['ls-remote', '--heads', 'origin', 'gh-pages'], { cwd: repo, encoding: 'utf8' }).stdout,
    ).toBe('');
  });
});
