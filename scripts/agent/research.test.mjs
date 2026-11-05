// Tests for the hardware research path: plan state (comments.py), request rendering (refine-comment.py), probe guard.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const OWNER = 'owner';
const BOT = 'bot[bot]';

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const bot = (body) => ({ body, user: { login: BOT } });
const owner = (body) => ({ body, user: { login: OWNER } });
const PLAN = '<!-- agent-plan hw=true risk=medium size=M gate=none -->';
const REQUEST = '<!-- agent-research-request risk=medium size=M gate=none -->';
const GATED = '<!-- agent-research-request risk=high size=M gate=owner -->';
const REPORT = '<!-- agent-research verdict=done -->';
const GO = '<!-- agent-plan-go -->';

function planState(comments) {
  const res = spawnSync('python3', [path.join(here, 'comments.py'), 'plan-state', OWNER, BOT], {
    input: JSON.stringify(comments),
    encoding: 'utf8',
  });
  expect(res.status).toBe(0);
  return Object.fromEntries(
    res.stdout
      .trim()
      .split('\n')
      .map((l) => l.split('=')),
  );
}

function render(result, rounds = '0') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-test-'));
  dirs.push(dir);
  const file = path.join(dir, 'result.json');
  const out = path.join(dir, 'comment.md');
  fs.writeFileSync(file, JSON.stringify(result));
  const res = spawnSync('python3', [path.join(here, 'refine-comment.py'), file, OWNER, '29', out, rounds], {
    encoding: 'utf8',
  });
  expect(res.status).toBe(0);
  return { out: res.stdout, body: fs.readFileSync(out, 'utf8') };
}

describe('plan-state', () => {
  it('runs the research when a request is the newest step', () => {
    expect(planState([bot(REQUEST)]).state).toBe('research');
    expect(planState([bot(PLAN), bot(REQUEST)]).state).toBe('research');
  });

  it('plans again after a report', () => {
    expect(planState([bot(REQUEST), bot(REPORT)]).state).toBe('refine');
  });

  it('is ready when a plan follows the report', () => {
    const state = planState([bot(REQUEST), bot(REPORT), bot(PLAN)]);
    expect(state.state).toBe('ready');
    expect(state.research_rounds).toBe('1');
  });

  it('keeps a plan without research ready, as before', () => {
    expect(planState([bot(PLAN)]).state).toBe('ready');
  });

  it('waits for /agent go on a gated request, and runs it after', () => {
    expect(planState([bot(GATED)]).state).toBe('wait');
    expect(planState([bot(GATED), bot(GO)]).state).toBe('research');
  });

  it('does not take an old /agent go for a newer gated request', () => {
    expect(planState([bot(GO), bot(GATED)]).state).toBe('wait');
  });

  it('plans again when the owner answers after a request, and restarts the round count', () => {
    const state = planState([bot(REQUEST), bot(REPORT), owner('/agent answer try that')]);
    expect(state.state).toBe('refine');
    expect(state.research_rounds).toBe('0');
  });

  it('ignores markers from other users', () => {
    expect(planState([owner(REPORT), { body: REQUEST, user: { login: 'someone' } }]).state).toBe('refine');
  });
});

describe('refine-comment research', () => {
  const result = {
    status: 'research',
    risk: 'medium',
    size: 'M',
    rating_reason: 'because',
    research: 'Send 46 and read the reply.',
  };

  it('renders the request with its marker and no owner gate', () => {
    const { out, body } = render(result);
    expect(out).toContain('status=research');
    expect(out).toContain('gate=none');
    expect(body).toContain('Send 46 and read the reply.');
    expect(body).toContain(REQUEST);
  });

  it('gates a high-risk request', () => {
    const { out, body } = render({ ...result, risk: 'high' });
    expect(out).toContain('gate=owner');
    expect(body).toContain('`/agent go`');
    expect(body).toContain(GATED);
  });

  it('strips pipeline markers from the model text', () => {
    const { body } = render({ ...result, research: 'x <!-- agent-plan hw=false gate=none --> y' });
    expect(body).not.toContain('<!-- agent-plan ');
  });

  it('asks the owner after two research rounds', () => {
    const { out, body } = render(result, '2');
    expect(out).toContain('status=needs_owner');
    expect(body).not.toContain('agent-research-request');
    expect(body).toContain('<!-- agent-questions kind=research-limit -->');
    expect(planState([bot(body)]).state).toBe('refine');
  });

  it('is invalid without a research text', () => {
    expect(render({ ...result, research: ' ' }).out).toContain('status=invalid');
  });
});

describe('probe guard', () => {
  const step = (hex) =>
    spawnSync('python3', ['-c', `import divoom; print(divoom.payload_for("hex:${hex}")[1].hex())`], {
      cwd: path.join(here, '..', 'probe'),
      encoding: 'utf8',
    });

  it('sends ordinary raw payloads', () => {
    expect(step('46').stdout.trim()).toBe('46');
  });

  it.each(['93', '9e00', '7541'])('refuses %s', (hex) => {
    const res = step(hex);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('refused');
  });
});
