import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { envelope } from '../protocol/envelope';
import type { Reply } from '../protocol/replies';
import type { DeviceStatus } from '../protocol/status';
import { ConnectionManager } from './ConnectionManager';
import type { ConnectionManagerOptions } from './ConnectionManager';
import { LinkLostError, NotConnectedError, RequestTimeoutError } from './errors';
import { MockTransport } from './MockTransport';
import { TransportError } from './Transport';
import { concat, heartbeatFrame, opcodeOf, replyFrame, seqOf, statusFrame } from './__fixtures__/frames';

const flush = () => vi.advanceTimersByTimeAsync(0);
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

interface Rig {
  t: MockTransport;
  m: ConnectionManager;
  logs: string[];
  errors: string[];
}

function rig(options: ConnectionManagerOptions = {}, answerPolls = true): Rig {
  const t = new MockTransport();
  if (answerPolls) t.autoReply = (w) => (opcodeOf(w) === 0x46 ? [statusFrame(42, 1)] : undefined);
  const logs: string[] = [];
  const errors: string[] = [];
  const m = new ConnectionManager(t, {
    random: () => 0,
    log: (l) => logs.push(l),
    error: (l) => errors.push(l),
    ...options,
  });
  return { t, m, logs, errors };
}

async function connected(options: ConnectionManagerOptions = {}, answerPolls = true): Promise<Rig> {
  const r = rig(options, answerPolls);
  r.m.start();
  await flush();
  expect(r.m.state).toBe('connected');
  return r;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('connect and poll', () => {
  it('connects, polls immediately with seq 0x0101 and logs the status', async () => {
    const { t, m, logs } = rig();
    const events: string[] = [];
    m.on('state', (s) => events.push(`state:${s}`));
    m.on('connected', () => events.push('connected'));
    m.start();
    await flush();
    expect(m.state).toBe('connected');
    expect(events).toEqual(['state:connecting', 'state:connected', 'connected']);
    expect(t.writes).toHaveLength(1);
    expect(t.writes[0]).toEqual(envelope(Uint8Array.of(0x46), 0x0101));
    expect(logs).toContain('[link] connecting (attempt 1)');
    expect(logs).toContain('[link] connected (seq reset)');
    expect(logs).toContain('[link] poll ok: brightness=42 channel=1');
  });

  it('polls on the interval and emits status events', async () => {
    const { t, m } = await connected();
    const seen: DeviceStatus[] = [];
    m.on('status', (s) => seen.push(s));
    await advance(60_000);
    expect(t.writes.filter((w) => opcodeOf(w) === 0x46)).toHaveLength(2);
    expect(seen).toHaveLength(1);
    expect(seen[0].brightness).toBe(42);
    expect(seen[0].channel).toBe(1);
  });

  it('emits reply events for every frame, including unsolicited ones', async () => {
    const { t, m } = await connected();
    const replies: Reply[] = [];
    m.on('reply', (r) => replies.push(r));
    t.emitData(heartbeatFrame());
    expect(replies.map((r) => r.cmd)).toEqual([0xf7]);
  });

  it('setPollInterval changes the live interval and validates its argument', async () => {
    const { t, m } = await connected();
    m.setPollInterval(10_000);
    await advance(10_000);
    expect(t.writes.filter((w) => opcodeOf(w) === 0x46)).toHaveLength(2);
    for (const bad of [9_999, 3_600_001, 15_000.5, Number.NaN]) {
      expect(() => m.setPollInterval(bad)).toThrow(RangeError);
    }
    expect(() => new ConnectionManager(t, { pollIntervalMs: 5 })).toThrow(RangeError);
    m.setPollInterval(3_600_000);
  });

  it('declares the link dead after two missed polls and reconnects', async () => {
    const { t, m, logs } = await connected({}, false);
    const reasons: string[] = [];
    m.on('disconnected', (r) => reasons.push(r));
    // First poll was sent at connect and is unanswered: 1/2 after the 5 s request timeout.
    await advance(5_000);
    expect(logs).toContain('[link] poll timeout (1/2)');
    expect(m.state).toBe('connected');
    // Second poll at 60 s, times out at 65 s: 2/2.
    await advance(60_000);
    expect(logs).toContain('[link] poll timeout (2/2)');
    expect(logs).toContain('[link] link dead, reconnecting');
    expect(reasons).toEqual(['poll timeout']);
    expect(t.closes).toBeGreaterThanOrEqual(1);
    await advance(2_000);
    expect(t.opens).toBe(2);
    expect(m.state).toBe('connected');
  });

  it('does not treat f7 heartbeats as liveness', async () => {
    const { t, m } = await connected({}, false);
    const reasons: string[] = [];
    m.on('disconnected', (r) => reasons.push(r));
    for (let i = 0; i < 13; i++) {
      t.emitData(heartbeatFrame());
      await advance(5_000);
    }
    expect(reasons).toEqual(['poll timeout']);
  });

  it('a late poll reply resets the missed counter', async () => {
    const { t, m, logs } = await connected({}, false);
    await advance(5_000);
    expect(logs).toContain('[link] poll timeout (1/2)');
    await advance(55_000); // second poll sent
    t.emitData(statusFrame());
    await flush();
    await advance(60_000); // third poll, again unanswered
    await advance(5_000);
    expect(logs.filter((l) => l.includes('poll timeout (1/2)'))).toHaveLength(2);
    expect(m.state).toBe('connected');
  });
});

describe('send', () => {
  it('rejects with NotConnectedError before start and while connecting', async () => {
    const { t, m } = rig();
    await expect(m.send(Uint8Array.of(0x74, 1))).rejects.toBeInstanceOf(NotConnectedError);
    await expect(m.request(Uint8Array.of(0x46), 0x46)).rejects.toBeInstanceOf(NotConnectedError);
    t.hangNextOpen();
    m.start();
    await flush();
    expect(m.state).toBe('connecting');
    await expect(m.send(Uint8Array.of(0x74, 1))).rejects.toBeInstanceOf(NotConnectedError);
  });

  it('writes the envelope in 20-byte chunks', async () => {
    const { t, m } = await connected();
    const payload = Uint8Array.from({ length: 30 }, (_, i) => 0x10 + i);
    t.writes.length = 0;
    await m.send(payload);
    expect(t.writes.map((w) => w.length)).toEqual([20, 20, 3]);
    expect(concat(t.writes)).toEqual(envelope(payload, 0x0102));
  });

  it('does not interleave chunks of concurrent sends and assigns seq in order', async () => {
    const { t, m } = await connected();
    t.writes.length = 0;
    const a = Uint8Array.from({ length: 30 }, () => 0xaa);
    const b = Uint8Array.from({ length: 30 }, () => 0xbb);
    t.holdWrites();
    const pa = m.send(a);
    const pb = m.send(b);
    await flush();
    t.releaseWrites();
    // releaseWrites only frees waiting writes; keep releasing while the queue drains.
    for (let i = 0; i < 10; i++) {
      t.releaseWrites();
      await flush();
    }
    await Promise.all([pa, pb]);
    expect(concat(t.writes)).toEqual(concat([envelope(a, 0x0102), envelope(b, 0x0103)]));
    expect(seqOf(t.writes[0])).toBe(0x0102);
    expect(seqOf(t.writes[3])).toBe(0x0103);
  });

  it('rejects an invalid payload without treating it as link loss', async () => {
    const { m } = await connected();
    await expect(m.send(new Uint8Array(0))).rejects.toThrow();
    expect(m.state).toBe('connected');
  });

  it('treats a write error as link loss and reconnects', async () => {
    const { t, m, logs } = await connected();
    t.writeErrors.push(new Error('GATT write failed'));
    await expect(m.send(Uint8Array.of(0x74, 5))).rejects.toBeInstanceOf(LinkLostError);
    expect(m.state).toBe('disconnected');
    expect(logs.some((l) => l.includes('disconnected: write failed: GATT write failed'))).toBe(true);
    await advance(2_000);
    expect(t.opens).toBe(2);
    expect(m.state).toBe('connected');
  });
});

describe('request', () => {
  it('resolves across split notifications and ignores other opcodes', async () => {
    const { t, m } = await connected();
    const pending = m.request(Uint8Array.of(0x31), 0x31);
    await flush();
    const frame = replyFrame(0x31, 0x2a);
    t.emitData(heartbeatFrame());
    t.emitData(frame.slice(0, 3));
    t.emitData(frame.slice(3, 5));
    t.emitData(frame.slice(5));
    const reply = await pending;
    expect(reply.cmd).toBe(0x31);
    expect(reply.ok).toBe(true);
    expect([...reply.data]).toEqual([0x2a]);
  });

  it('registers the waiter before the write so an instant reply is not lost', async () => {
    const { t, m } = await connected();
    t.autoReply = (w) => (opcodeOf(w) === 0x31 ? [replyFrame(0x31, 7)] : undefined);
    const reply = await m.request(Uint8Array.of(0x31), 0x31);
    expect([...reply.data]).toEqual([7]);
  });

  it('times out with RequestTimeoutError and clears the receive buffer', async () => {
    const { t, m } = await connected();
    const first = m.request(Uint8Array.of(0x31), 0x31, 1_000);
    const caught = first.catch((e: unknown) => e);
    await flush();
    // A stale partial frame that claims 1023 bytes would swallow everything after it.
    t.emitData(Uint8Array.of(0x01, 0xff, 0x03, 0x04, 0x31));
    await advance(1_000);
    expect(await caught).toBeInstanceOf(RequestTimeoutError);
    const second = m.request(Uint8Array.of(0x31), 0x31, 1_000);
    await flush();
    t.emitData(replyFrame(0x31, 9));
    expect([...(await second).data]).toEqual([9]);
  });

  it('rejects pending and queued calls with LinkLostError when the link drops', async () => {
    const r = rig({}, false);
    r.t.holdWrites();
    r.m.start();
    await flush();
    const send = r.m.send(Uint8Array.of(0x74, 1));
    const request = r.m.request(Uint8Array.of(0x31), 0x31);
    const results = Promise.allSettled([send, request]);
    await flush();
    r.t.dropLink();
    const settled = await results;
    expect(settled.map((s) => s.status)).toEqual(['rejected', 'rejected']);
    for (const s of settled) expect((s as PromiseRejectedResult).reason).toBeInstanceOf(LinkLostError);
    expect(r.m.state).toBe('disconnected');
  });
});

describe('request with accept filter', () => {
  const customPageOnly = (r: Reply): boolean => r.data[0] === 0x17;

  it('keeps waiting on a rejected frame with the right opcode and resolves on the accepted one', async () => {
    const { t, m } = await connected();
    const replies: Reply[] = [];
    m.on('reply', (r) => replies.push(r));
    const pending = m.request(Uint8Array.of(0xbd, 0x17, 0xff), 0xbd, 1_000, customPageOnly);
    let settled = false;
    void pending.then(() => (settled = true));
    await flush();
    t.emitData(replyFrame(0xbd, 0x13, 0x01, 0x32, 0x00));
    await flush();
    expect(settled).toBe(false);
    t.emitData(replyFrame(0xbd, 0x17, 0x01));
    const reply = await pending;
    expect([...reply.data]).toEqual([0x17, 0x01]);
    // The refused frame is still a reply event for everyone else.
    expect(replies.map((r) => [...r.data])).toEqual([
      [0x13, 0x01, 0x32, 0x00],
      [0x17, 0x01],
    ]);
  });

  it('still times out when only rejected frames arrive', async () => {
    const { t, m } = await connected();
    const caught = m.request(Uint8Array.of(0xbd, 0x17, 0xff), 0xbd, 1_000, customPageOnly).catch((e: unknown) => e);
    await flush();
    t.emitData(replyFrame(0xbd, 0x13, 0x01, 0x1e, 0x00));
    await advance(1_000);
    expect(await caught).toBeInstanceOf(RequestTimeoutError);
  });

  it('treats a throwing predicate as not accepted and logs it', async () => {
    const r = await connected();
    const pending = r.m.request(Uint8Array.of(0xbd, 0x17, 0xff), 0xbd, 1_000, () => {
      throw new Error('boom');
    });
    const caught = pending.catch((e: unknown) => e);
    await flush();
    r.t.emitData(replyFrame(0xbd, 0x17, 0x01));
    await advance(1_000);
    expect(await caught).toBeInstanceOf(RequestTimeoutError);
    expect(r.logs.some((l) => l.includes('reply filter threw for opcode bd: boom'))).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('without accept every frame with the opcode answers, as before', async () => {
    const { t, m } = await connected();
    const pending = m.request(Uint8Array.of(0xbd, 0x17, 0xff), 0xbd, 1_000);
    await flush();
    t.emitData(replyFrame(0xbd, 0x13, 0x01, 0x32, 0x00));
    expect([...(await pending).data]).toEqual([0x13, 0x01, 0x32, 0x00]);
  });
});

describe('request validation', () => {
  it('rejects (never throws) an invalid expected opcode or timeout with RangeError, also while disconnected', async () => {
    const { m, t } = await connected();
    const payload = Uint8Array.of(0x31);
    const writes = t.writes.length;
    for (const cmd of [-1, 256, 1.5, Number.NaN]) await expect(m.request(payload, cmd)).rejects.toThrow(RangeError);
    for (const ms of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31]) {
      await expect(m.request(payload, 0x31, ms)).rejects.toThrow(RangeError);
    }
    expect(t.writes).toHaveLength(writes);
    await expect(new ConnectionManager(t).request(payload, 256)).rejects.toThrow(RangeError);
    const ok = m.request(payload, 0xff, 2 ** 31 - 1);
    const caught = ok.catch((e: unknown) => e);
    await m.stop();
    expect(await caught).toBeInstanceOf(LinkLostError);
  });
});

describe('timing option validation', () => {
  it('rejects an invalid connectTimeoutMs or closeTimeoutMs with a RangeError naming the option', () => {
    const t = new MockTransport();
    expect(() => new ConnectionManager(t, { connectTimeoutMs: -1 })).toThrow(RangeError);
    expect(() => new ConnectionManager(t, { connectTimeoutMs: -1 })).toThrow(/connectTimeoutMs/);
    expect(() => new ConnectionManager(t, { closeTimeoutMs: Number.NaN })).toThrow(/closeTimeoutMs/);
    expect(() => new ConnectionManager(t, { closeTimeoutMs: 2 ** 31 })).toThrow(RangeError);
    expect(() => new ConnectionManager(t, { connectTimeoutMs: 1, closeTimeoutMs: 2 ** 31 - 1 })).not.toThrow();
    expect(() => new ConnectionManager(t)).not.toThrow();
  });
});

describe('reconnect', () => {
  it('resets the sequence counter and the receive buffer on every connection', async () => {
    const { t, m } = await connected();
    await m.send(Uint8Array.of(0x74, 1)); // seq 0x0102
    t.emitData(Uint8Array.of(0x01, 0xff, 0x03)); // dangling partial frame
    t.dropLink();
    await advance(2_000);
    expect(m.state).toBe('connected');
    const polls = t.writes.filter((w) => opcodeOf(w) === 0x46);
    expect(seqOf(polls[polls.length - 1])).toBe(0x0101);
    // The partial frame of the old connection must not swallow this reply.
    const reply = m.request(Uint8Array.of(0x31), 0x31);
    await flush();
    t.emitData(replyFrame(0x31, 3));
    expect([...(await reply).data]).toEqual([3]);
  });

  it('backs off with equal jitter (random=0 gives cap/2, random=1 gives cap) up to the cap', async () => {
    for (const [random, expected] of [
      [0, [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]],
      [1, [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]],
    ] as const) {
      const r = rig({ random: () => random });
      r.m.start();
      await flush();
      r.t.failNextOpen();
      r.t.dropLink();
      for (const delay of expected) {
        await flush();
        const opens = r.t.opens;
        await advance(delay - 1);
        expect(r.t.opens).toBe(opens);
        r.t.failNextOpen();
        await advance(1);
        expect(r.t.opens).toBe(opens + 1);
      }
      await r.m.stop();
    }
  });

  it('resets the attempt counter after the first successful poll', async () => {
    const r = rig();
    r.m.start();
    await flush();
    r.t.failNextOpen();
    r.t.dropLink(); // attempt 0 -> 1 s
    await advance(1_000); // fails -> 2 s
    r.t.failNextOpen();
    await advance(2_000); // fails -> 4 s
    await advance(4_000); // succeeds, poll ok resets
    expect(r.m.state).toBe('connected');
    r.t.dropLink();
    const opens = r.t.opens;
    await advance(1_000);
    expect(r.t.opens).toBe(opens + 1);
  });

  it('logs the retry delay and the connect failure reason', async () => {
    const r = rig();
    r.t.failNextOpen(new TransportError('device not found'));
    r.m.start();
    await flush();
    expect(r.logs).toContain('[link] connect failed: device not found; retry in 1s');
    expect(r.m.state).toBe('disconnected');
  });

  it('waits 300 s after a permanent error', async () => {
    const r = rig();
    r.t.failNextOpen(new TransportError('GATT service missing', true));
    r.m.start();
    await flush();
    expect(r.logs.some((l) => l.startsWith('[link] permanent error: GATT service missing; retry in 300s'))).toBe(true);
    await advance(299_999);
    expect(r.t.opens).toBe(1);
    await advance(1);
    expect(r.t.opens).toBe(2);
    expect(r.m.state).toBe('connected');
  });

  it('emits connectFailed with the reason, the permanent flag and the retry delay', async () => {
    const r = rig();
    const seen: unknown[] = [];
    r.m.on('connectFailed', (info) => seen.push(info));
    r.t.failNextOpen(new TransportError('device not found'));
    r.m.start();
    await flush();
    expect(seen).toEqual([{ reason: 'device not found', permanent: false, retryInMs: 1_000 }]);
    r.t.failNextOpen(new TransportError('GATT service missing', true));
    await advance(1_000);
    expect(seen).toEqual([
      { reason: 'device not found', permanent: false, retryInMs: 1_000 },
      { reason: 'GATT service missing', permanent: true, retryInMs: 300_000 },
    ]);
  });

  it('does not emit connectFailed for a lost link or a stopped manager', async () => {
    const r = await connected();
    const seen: unknown[] = [];
    r.m.on('connectFailed', (info) => seen.push(info));
    r.t.dropLink();
    await flush();
    r.t.hangNextOpen();
    await advance(1_000);
    await r.m.stop();
    await flush();
    expect(seen).toEqual([]);
  });

  it('closes the transport and retries when connecting takes longer than the timeout', async () => {
    const r = rig();
    r.t.hangNextOpen();
    r.m.start();
    await advance(29_999);
    expect(r.t.closes).toBe(0);
    await advance(1);
    expect(r.t.closes).toBe(1);
    expect(r.logs.some((l) => l.startsWith('[link] connect failed: timeout after 30s'))).toBe(true);
    await advance(1_000);
    expect(r.t.opens).toBe(2);
    expect(r.m.state).toBe('connected');
  });

  it('ignores callbacks of a stale session', async () => {
    const { t, m } = await connected();
    const old = t.handlerLog[0];
    t.dropLink();
    await advance(2_000);
    expect(m.state).toBe('connected');
    const closes = t.closes;
    const replies: Reply[] = [];
    m.on('reply', (r) => replies.push(r));
    old.onClose();
    old.onData(heartbeatFrame());
    expect(m.state).toBe('connected');
    expect(t.closes).toBe(closes);
    expect(replies).toHaveLength(0);
  });
});

describe('robustness and lifecycle', () => {
  it('survives garbage, bad CRCs and throwing listeners', async () => {
    const { t, m, errors } = await connected();
    m.on('reply', () => {
      throw new Error('listener bug');
    });
    t.emitData(Uint8Array.of(0, 2, 3, 255, 1, 0, 0, 9));
    t.emitData(Uint8Array.from({ length: 64 }, (_, i) => (i * 37) & 0xff));
    const bad = replyFrame(0x31, 1);
    bad[6] = 2; // data byte changed, CRC no longer matches
    t.emitData(bad);
    t.emitData(heartbeatFrame());
    expect(m.state).toBe('connected');
    expect(errors.some((e) => e.includes('listener bug'))).toBe(true);
  });

  it('stop() leaves no timers, rejects pending calls and allows a restart', async () => {
    const r = rig({}, false);
    r.m.start();
    await flush();
    const request = r.m.request(Uint8Array.of(0x31), 0x31);
    const caught = request.catch((e: unknown) => e);
    const disconnects: string[] = [];
    r.m.on('disconnected', (reason) => disconnects.push(reason));
    await r.m.stop();
    expect(await caught).toBeInstanceOf(LinkLostError);
    expect(disconnects).toEqual(['stopped']);
    expect(r.m.state).toBe('disconnected');
    expect(r.t.closes).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    await advance(600_000);
    expect(r.t.opens).toBe(1);

    r.m.start();
    await flush();
    expect(r.t.opens).toBe(2);
    expect(r.m.state).toBe('connected');
    const polls = r.t.writes.filter((w) => opcodeOf(w) === 0x46);
    expect(seqOf(polls[polls.length - 1])).toBe(0x0101);
    await r.m.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stop() while waiting for a retry cancels the retry', async () => {
    const r = rig();
    r.t.failNextOpen();
    r.m.start();
    await flush();
    await r.m.stop();
    expect(vi.getTimerCount()).toBe(0);
    await advance(600_000);
    expect(r.t.opens).toBe(1);
  });

  it('a connected listener that calls stop() leaves no poll timer or poll write behind', async () => {
    const r = rig();
    r.m.on('connected', () => void r.m.stop());
    r.m.start();
    await flush();
    await advance(120_000);
    expect(r.t.writes).toHaveLength(0);
    expect(r.m.state).toBe('disconnected');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for the previous close() before the next open', async () => {
    const r = rig();
    let finishClose!: () => void;
    const order: string[] = [];
    const realOpen = r.t.open.bind(r.t);
    const realClose = r.t.close.bind(r.t);
    r.t.open = async (h) => {
      order.push('open');
      await realOpen(h);
    };
    r.t.close = async () => {
      order.push('close start');
      await realClose();
      await new Promise<void>((resolve) => (finishClose = resolve));
      order.push('close done');
    };
    r.m.start();
    await flush();
    r.t.dropLink();
    await advance(5_000); // backoff elapsed, but close() is still running
    expect(order).toEqual(['open', 'close start']);
    expect(r.m.state).toBe('connecting');
    finishClose();
    await flush();
    expect(order).toEqual(['open', 'close start', 'close done', 'open']);
    expect(r.m.state).toBe('connected');
  });

  it('turns a synchronous throw of transport.open into a failed connect', async () => {
    const r = rig();
    r.t.open = () => {
      throw new Error('boom');
    };
    r.m.start();
    await flush();
    expect(r.logs.some((l) => l.startsWith('[link] connect failed: boom; retry in'))).toBe(true);
    expect(r.m.state).toBe('disconnected');
    await r.m.stop();
  });

  it('a state listener that stops on "connected" gets neither a connected nor a disconnected event', async () => {
    const r = rig();
    const events: string[] = [];
    r.m.on('state', (s) => {
      events.push(`state:${s}`);
      if (s === 'connected') void r.m.stop();
    });
    r.m.on('connected', () => events.push('connected'));
    r.m.on('disconnected', (reason) => events.push(`disconnected:${reason}`));
    r.m.start();
    await flush();
    expect(events).toEqual(['state:connecting', 'state:connected', 'state:disconnected']);
    expect(r.t.writes).toHaveLength(0);
    expect(r.logs).not.toContain('[link] disconnected: stopped');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a connected listener that calls stop() still gets connected before disconnected', async () => {
    const r = rig();
    const events: string[] = [];
    r.m.on('connected', () => {
      events.push('connected');
      void r.m.stop();
    });
    r.m.on('disconnected', (reason) => events.push(`disconnected:${reason}`));
    r.m.start();
    await flush();
    expect(events).toEqual(['connected', 'disconnected:stopped']);
  });

  it('stop() resolves after closeTimeoutMs when transport.close() never settles', async () => {
    const r = await connected();
    r.t.close = () => new Promise<void>(() => undefined);
    let stopped = false;
    void r.m.stop().then(() => (stopped = true));
    await advance(9_999);
    expect(stopped).toBe(false);
    await advance(1);
    expect(stopped).toBe(true);
    expect(r.logs).toContain('[link] close did not finish within 10s; continuing');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a hung close() delays the next open by at most closeTimeoutMs, then reconnects', async () => {
    const r = await connected({ closeTimeoutMs: 3_000 });
    const realClose = r.t.close.bind(r.t);
    r.t.close = () => {
      r.t.close = realClose;
      return new Promise<void>(() => undefined);
    };
    r.t.dropLink();
    await advance(2_999); // backoff (1 s) elapsed, still waiting for the hung close
    expect(r.t.opens).toBe(1);
    expect(r.m.state).toBe('connecting');
    await advance(1);
    expect(r.t.opens).toBe(2);
    expect(r.m.state).toBe('connected');
    expect(r.logs).toContain('[link] close did not finish within 3s; continuing');
    await r.m.stop();
  });

  it('start() is idempotent', async () => {
    const r = rig();
    r.m.start();
    r.m.start();
    await flush();
    expect(r.t.opens).toBe(1);
  });
});
