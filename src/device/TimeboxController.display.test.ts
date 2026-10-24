import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toHex } from '../protocol/hex';
import { opcodeOf, replyFrame, sppFrame, statusFrame } from '../transport/__fixtures__/frames';
import { rig } from './__fixtures__/controllerRig';
import type { Rig } from './__fixtures__/controllerRig';
import { CHANNEL_CONFIRM_TIMEOUT_MS } from './TimeboxController';

const flush = () => vi.advanceTimersByTimeAsync(0);
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

/** A started controller whose first status reply (channel `initialChannel`) has been processed. */
async function online(initialChannel = 0): Promise<Rig> {
  const r = rig();
  r.device.channel = initialChannel;
  r.c.start();
  await flush();
  expect(r.m.state).toBe('connected');
  return r;
}

/** The payloads (hex) written since the last reset: chunks are joined back into envelopes. */
function payloads(r: Rig): string[] {
  const all = Uint8Array.from(r.t.writes.flatMap((w) => [...w]));
  const out: string[] = [];
  for (let at = 0; at < all.length;) {
    const len = all[at + 4] | (all[at + 5] << 8);
    out.push(toHex(all.subarray(at + 11, at + 6 + len - 2)));
    at += 6 + len;
  }
  return out;
}

/** The simulated Evo keeps its behaviour but never answers `45 05` (no `45 55 05`). */
function dropCustomAck(r: Rig): void {
  const original = r.t.autoReply!;
  r.t.autoReply = (w) => {
    const out = original(w);
    return opcodeOf(w) === 0x45 && w[12] === 0x05 ? undefined : out;
  };
}

/** The simulated Evo answers one opcode with the given frames instead (the state is still updated). */
function answer(r: Rig, opcode: number, frames: Uint8Array[]): void {
  const original = r.t.autoReply!;
  r.t.autoReply = (w) => {
    const out = original(w);
    return opcodeOf(w) === opcode ? frames : out;
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('showCustomPage (Flow)', () => {
  it('sends 45 05, then bd 17 PP, confirms with 46 and reads the page with bd 17 ff', async () => {
    const r = await online(0);
    r.t.writes.length = 0;
    await r.c.showCustomPage(1);
    expect(payloads(r)).toEqual(['45 05', 'bd 17 01', '46', 'bd 17 ff']);
    expect(r.surface.logs).toContain('[device] custom page -> 2: bd 17 01');
    expect(r.surface.logs).toContain('[device] channel confirmed: custom');
    expect(r.surface.logs).toContain('[device] custom page confirmed: 2');
    expect(r.device.customPage).toBe(1);
    expect(r.c.getChannel()).toBe('custom');
  });

  it.each([0, 2])('encodes page index %i', async (page) => {
    const r = await online(0);
    r.t.writes.length = 0;
    await r.c.showCustomPage(page);
    expect(payloads(r)[1]).toBe(`bd 17 0${page}`);
  });

  it('fires the channel trigger on a change, not on a repeat', async () => {
    const r = await online(0);
    await r.c.showCustomPage(0);
    await r.c.showCustomPage(2);
    expect(r.surface.channelChanges).toEqual(['custom']);
  });

  it('switches the panel on while off', async () => {
    const r = await online(5);
    await r.c.setPower(false);
    r.surface.onoffs.length = 0;
    await r.c.showCustomPage(2);
    expect(r.c.isOn()).toBe(true);
    expect(r.surface.onoffs).toEqual([true]);
    expect(r.device.power).toBe(true);
  });

  it('the plain custom channel (picker) still sends only 45 05', async () => {
    const r = await online(0);
    r.t.writes.length = 0;
    await r.c.setChannel('custom');
    expect(payloads(r)).toEqual(['45 05', '46']);
  });

  it('waits for the 45 ack, then sends the page anyway after the timeout', async () => {
    const r = await online(0);
    dropCustomAck(r);
    r.t.writes.length = 0;
    const p = r.c.showCustomPage(1);
    await advance(CHANNEL_CONFIRM_TIMEOUT_MS - 1);
    expect(payloads(r)).toEqual(['45 05']);
    await advance(1);
    await p;
    expect(payloads(r)).toEqual(['45 05', 'bd 17 01', '46', 'bd 17 ff']);
    expect(r.surface.logs).toContain('[device] custom page: no 45 ack, sending the page anyway');
    expect(r.surface.logs).toContain('[device] custom page confirmed: 2');
  });

  it('sends the page as soon as the 45 55 05 ack arrives', async () => {
    const r = await online(0);
    dropCustomAck(r);
    r.t.writes.length = 0;
    const p = r.c.showCustomPage(1);
    await flush();
    expect(payloads(r)).toEqual(['45 05']);
    r.t.emitData(replyFrame(0x45, 0x05));
    await p;
    expect(payloads(r)).toEqual(['45 05', 'bd 17 01', '46', 'bd 17 ff']);
    expect(r.surface.logs).toContain('[device] channel -> custom: 45 05');
    expect(r.surface.logs).not.toContain('[device] custom page: no 45 ack, sending the page anyway');
  });

  it('does not take the 45 ack of another channel or a failed 45 reply for the ack of 45 05', async () => {
    const r = await online(0);
    dropCustomAck(r);
    r.t.writes.length = 0;
    const p = r.c.showCustomPage(1);
    await flush();
    r.t.emitData(replyFrame(0x45, 0x02)); // a late ack of another channel
    r.t.emitData(sppFrame([0x04, 0x45, 0xaa, 0x05])); // status byte is not 55
    r.t.emitData(replyFrame(0x45)); // no data
    await flush();
    expect(payloads(r)).toEqual(['45 05']);
    await advance(CHANNEL_CONFIRM_TIMEOUT_MS);
    await p;
    expect(payloads(r)).toEqual(['45 05', 'bd 17 01', '46', 'bd 17 ff']);
    expect(r.surface.logs).toContain('[device] custom page: no 45 ack, sending the page anyway');
  });

  it('a superseded page is not sent and leaves the known channel, the trigger and the result to the newer change', async () => {
    const r = await online(0);
    dropCustomAck(r);
    r.surface.channelChanges.length = 0;
    r.t.writes.length = 0;
    const page = r.c.showCustomPage(1);
    await flush();
    await r.c.setChannel('lighting'); // completes while the 45 ack of the page is still outstanding
    expect(r.c.getChannel()).toBe('lighting');
    r.t.emitData(replyFrame(0x45, 0x05)); // the late ack
    await expect(page).resolves.toBe(false);
    expect(payloads(r).filter((p) => p.startsWith('bd 17'))).toEqual([]);
    expect(r.surface.logs).toContain('[device] channel -> custom: 45 05');
    expect(r.surface.logs).toContain('[device] channel custom superseded by a newer change');
    expect(r.surface.logs.some((l) => l.includes('custom page ->'))).toBe(false);
    expect(r.c.getChannel()).toBe('lighting');
    expect(r.surface.channelChanges).toEqual(['lighting']);
    expect(r.device.channel).toBe(1);
  });

  it('a link drop during the ack wait rejects at once with the not-connected error and sends nothing more', async () => {
    const r = await online(0);
    dropCustomAck(r);
    const replyListeners = r.m.listenerCount('reply');
    const disconnectListeners = r.m.listenerCount('disconnected');
    r.surface.channelChanges.length = 0;
    r.t.writes.length = 0;
    const page = r.c.showCustomPage(1);
    const settled = page.then(
      () => 'resolved',
      (e: Error) => `rejected: ${e.message}`,
    );
    await flush();
    expect(r.m.listenerCount('reply')).toBe(replyListeners + 1);
    r.t.dropLink();
    await flush();
    expect(await settled).toBe('rejected: not connected text');
    // the action itself updated no state (a later device report after the reconnect is a different matter)
    expect(r.surface.channelChanges).toEqual([]);
    expect(r.c.getChannel()).toBe('clock');
    await advance(CHANNEL_CONFIRM_TIMEOUT_MS);
    expect(payloads(r).filter((p) => p.startsWith('bd 17'))).toEqual([]);
    expect(r.m.listenerCount('reply')).toBe(replyListeners);
    expect(r.m.listenerCount('disconnected')).toBe(disconnectListeners);
  });

  it('stop() during the ack wait rejects at once and removes the wait listeners', async () => {
    const r = await online(0);
    dropCustomAck(r);
    const page = r.c.showCustomPage(1);
    const settled = page.then(
      () => 'resolved',
      (e: Error) => `rejected: ${e.message}`,
    );
    await flush();
    const during = r.m.listenerCount('reply');
    void r.c.stop();
    await flush();
    expect(await settled).toBe('rejected: not connected text');
    expect(r.m.listenerCount('reply')).toBe(during - 2); // the wait's and the controller's own listener
    expect(r.m.listenerCount('disconnected')).toBe(0);
    expect(r.surface.channelChanges).toEqual([]);
  });

  it('a superseded page that never gets its ack ends at the ack timeout without sending the page', async () => {
    const r = await online(0);
    dropCustomAck(r);
    r.t.writes.length = 0;
    const page = r.c.showCustomPage(1);
    await flush();
    await r.c.setChannel('lighting');
    await advance(CHANNEL_CONFIRM_TIMEOUT_MS);
    await expect(page).resolves.toBe(false);
    expect(payloads(r).filter((p) => p.startsWith('bd 17'))).toEqual([]);
    expect(r.c.getChannel()).toBe('lighting');
    expect(r.surface.channelChanges).toEqual(['lighting']);
  });

  it('ignores a stale channel report while in flight', async () => {
    const r = await online(0);
    r.surface.channels.length = 0;
    r.t.holdWrites();
    const p = r.c.showCustomPage(1);
    await flush();
    r.t.emitData(statusFrame(50, 0));
    expect(r.surface.channels).toEqual([]);
    r.t.releaseWrites();
    await p;
    expect(r.surface.channels).toEqual([]);
  });

  it('logs a mismatch if the device reports another page or a code outside 1..3', async () => {
    const r = await online(0);
    answer(r, 0xbd, [replyFrame(0xbd, 0x17, 2)]);
    await r.c.showCustomPage(0);
    expect(r.surface.logs).toContain('[device] custom page mismatch: device 3, requested 1');
    answer(r, 0xbd, [replyFrame(0xbd, 0x17, 0xff)]);
    await r.c.showCustomPage(0);
    expect(r.surface.logs).toContain('[device] custom page mismatch: device code 0xff, requested 1');
  });

  it('is not answered by an unsolicited bd 55 13 frame in front of the real bd 55 17 answer (#101)', async () => {
    const r = await online(0);
    const original = r.t.autoReply!;
    r.t.autoReply = (w) => {
      const out = original(w);
      return opcodeOf(w) === 0xbd && w[13] === 0xff
        ? [replyFrame(0xbd, 0x13, 0x01, 0x32, 0x00), replyFrame(0xbd, 0x13, 0x01, 0x1e, 0x00), ...(out ?? [])]
        : out;
    };
    await expect(r.c.showCustomPage(1)).resolves.toBe(true);
    expect(r.surface.logs).toContain('[device] custom page confirmed: 2');
    expect(r.surface.logs.some((l) => l.includes('custom page confirm failed'))).toBe(false);
    expect(r.surface.errors).toEqual([]);
  });

  it('logs a confirm timeout and rejects with not_confirmed (#151)', async () => {
    const r = await online(0);
    r.device.answerPage = false;
    const p = r.c.showCustomPage(1);
    const failed = expect(p).rejects.toThrow('not confirmed text');
    await advance(CHANNEL_CONFIRM_TIMEOUT_MS);
    await failed;
    expect(r.surface.logs).toContain('[device] custom page confirm timeout');
  });

  it('logs a failed confirm for a malformed reply and rejects with not_confirmed (#151)', async () => {
    const r = await online(0);
    answer(r, 0xbd, [replyFrame(0xbd, 0x17)]);
    await expect(r.c.showCustomPage(1)).rejects.toThrow('not confirmed text');
    expect(r.surface.logs.some((l) => l.startsWith('[device] custom page confirm failed:'))).toBe(true);
  });

  it('does not ask for the page if the device is not on the custom channel', async () => {
    const r = await online(0);
    answer(r, 0x46, [statusFrame(50, 0)]);
    r.t.writes.length = 0;
    await r.c.showCustomPage(1);
    expect(payloads(r)).toEqual(['45 05', 'bd 17 01', '46']);
    expect(r.surface.logs).toContain('[device] channel mismatch: device clock, requested custom');
  });

  it.each([3, -1, 255, 1.5, NaN])(
    'rejects %s before anything is written and does not supersede a pending switch',
    async (page) => {
      const r = await online(1);
      r.t.writes.length = 0;
      await expect(r.c.showCustomPage(page)).rejects.toThrow(RangeError);
      expect(r.t.writes).toHaveLength(0);
      const pending = r.c.setChannel('lighting');
      await expect(r.c.showCustomPage(page)).rejects.toThrow(RangeError);
      await pending;
      expect(r.surface.logs).toContain('[device] channel confirmed: lighting');
      expect(r.surface.logs).not.toContain('[device] channel lighting superseded by a newer change');
    },
  );

  it('gives a readable error and writes nothing while not connected (after validating)', async () => {
    const r = rig();
    await expect(r.c.showCustomPage(1)).rejects.toThrow('not connected text');
    await expect(r.c.showCustomPage(3)).rejects.toThrow(RangeError);
    expect(r.t.writes).toHaveLength(0);
  });
});
