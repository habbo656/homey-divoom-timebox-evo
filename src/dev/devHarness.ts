// Development harness for hardware tests, active only when the app runs with DEBUG=1 (`homey app run`). A test writes a
// command into the app setting `devLink` (`homey api` / settings API) and reads the result from the app log:
//
//   connect        scan up to 60 s for the strongest Timebox (stops when found), build BleTransport -> FaultTransport -> ConnectionManager and start
//                  (refused while a paired device owns the BLE link, see below)
//   drop           simulate a lost link (reconnect + sequence reset expected)
//   mute           swallow device notifications until the next reconnect (2 missed polls -> link dead expected)
//   brightness:N   send `74 N` (0..100) and log the status that the device reports afterwards
//   poll:S         set the liveness poll interval to S seconds (10..3600)
//   time:YYYYMMDDhhmm  set the device clock with `18` (seconds 0, weekday computed), e.g. time:200101010101, and log it
//   calendar       switch to the clock view with weekday/date shown (`45 00 01 00 01 01 01 01 ff ff ff`: 24 h, full screen
//                  style, weather/temperature/calendar flags on, white): makes a wrong date visible on a photo. Replaced by the
//                  clock builder of #25.
//   channel:N      send `45 N` (N = 0 clock, 2 cloud, 5 custom, 6 scoreboard) directly on the link, bypassing the device
//                  controller: simulates a channel change made on the device (the tile follows at the next poll, see poll:S)
//   mem            log the process memory (`[dev] memory: rss=… heapUsed=… heapTotal=… external=…`, MB; heap from
//                  v8.getHeapStatistics(), rss/external `n/a` where process.memoryUsage() throws, e.g. on Homey); needs no link
//   stop           stop the harness's own manager
//
// Device link: with DEBUG=1 every paired device registers its own link through `attachDevLink` (src/device/TimeboxDevice.ts).
// While one is attached, `drop`, `mute`, `poll` and `brightness` act on it (the first attached device if there are
// several), `connect` and `stop` are refused, and the harness's own link is stopped when a device attaches: the Timebox
// accepts only one BLE connection.
//
// A suffix `#anything` is ignored, so the same command can be written twice (a setting only fires `set` on a write).
// The value that is stored in the setting when the app starts is never executed.
import { getHeapStatistics } from 'node:v8';
import { queryStatus, setBrightness, setChannel, setClock, setDateTime, SIMPLE_CHANNELS } from '../protocol/commands';
import type { DateTimeParts } from '../protocol/commands';
import { toHex } from '../protocol/hex';
import { decodeStatus } from '../protocol/status';
import { BleTransport, DiscoveryError, discoverTimeboxes } from '../transport/BleTransport';
import type { BleManagerLike } from '../transport/BleTransport';
import { ConnectionManager } from '../transport/ConnectionManager';
import { FaultTransport } from './FaultTransport';

export const DEV_SETTING_KEY = 'devLink';

/** `45 00 01 00 01 01 01 01 ff ff ff`: 24 h, full screen, weather/temperature/calendar on, white (protocol section 5.1). */
const CALENDAR_CLOCK = setClock({
  hour24: true,
  style: 0,
  weather: true,
  temperature: true,
  calendar: true,
  color: { r: 255, g: 255, b: 255 },
});

export type DevCommand =
  | { kind: 'connect' }
  | { kind: 'drop' }
  | { kind: 'mute' }
  | { kind: 'stop' }
  | { kind: 'brightness'; percent: number }
  | { kind: 'channel'; code: number }
  | { kind: 'poll'; seconds: number }
  | { kind: 'time'; parts: DateTimeParts }
  | { kind: 'calendar' }
  | { kind: 'mem' };

/** Parse a `devLink` value (string, or an object with a `cmd` string). Returns null for anything invalid. */
export function parseDevCommand(raw: unknown): DevCommand | null {
  let text: unknown = raw;
  if (typeof raw === 'object' && raw !== null && 'cmd' in raw) text = (raw as { cmd: unknown }).cmd;
  if (typeof text !== 'string') return null;
  const cmd = text.split('#')[0].trim().toLowerCase();
  switch (cmd) {
    case 'connect':
    case 'drop':
    case 'mute':
    case 'stop':
    case 'calendar':
    case 'mem':
      return { kind: cmd };
  }
  const brightness = /^brightness:(\d{1,3})$/.exec(cmd);
  if (brightness) {
    const percent = Number(brightness[1]);
    return percent <= 100 ? { kind: 'brightness', percent } : null;
  }
  const channel = /^channel:(\d{1,3})$/.exec(cmd);
  if (channel) {
    const code = Number(channel[1]);
    return (SIMPLE_CHANNELS as readonly number[]).includes(code) ? { kind: 'channel', code } : null;
  }
  const poll = /^poll:(\d{1,4})$/.exec(cmd);
  if (poll) {
    const seconds = Number(poll[1]);
    return seconds >= 10 && seconds <= 3600 ? { kind: 'poll', seconds } : null;
  }
  const time = /^time:(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(cmd);
  if (time) {
    const [year, month, day, hour, minute] = time.slice(1).map(Number);
    const parts = { year, month, day, hour, minute, second: 0 };
    try {
      setDateTime(parts); // the one place that knows which dates exist
    } catch {
      return null;
    }
    return { kind: 'time', parts };
  }
  return null;
}

/** Process memory in bytes; `rss`/`external` are `null` where the runtime cannot report them. */
export interface MemorySample {
  heapUsed: number;
  heapTotal: number;
  rss: number | null;
  external: number | null;
}

/** Where `readMemory` gets its numbers from (injectable for tests). */
export interface MemorySource {
  heap(): { used_heap_size: number; total_heap_size: number };
  usage(): Pick<NodeJS.MemoryUsage, 'rss' | 'external'>;
}

const processMemory: MemorySource = {
  heap: () => getHeapStatistics(),
  usage: () => process.memoryUsage(),
};

/**
 * Reads the process memory. The heap comes from `v8.getHeapStatistics()`, which works everywhere. `process.memoryUsage()`
 * throws `ENOENT: no such file or directory, uv_resident_set_memory` in the Homey app sandbox (rss is read through libuv,
 * and `process.memoryUsage.rss()` uses the same call), so rss and external are optional.
 */
export function readMemory(source: MemorySource = processMemory): MemorySample {
  const heap = source.heap();
  let rss: number | null = null;
  let external: number | null = null;
  try {
    ({ rss, external } = source.usage());
  } catch {
    // Not available in this runtime (Homey sandbox): reported as n/a.
  }
  return { heapUsed: heap.used_heap_size, heapTotal: heap.total_heap_size, rss, external };
}

/** `[dev] memory: …` line for the soak driver (`scripts/soak.sh`): the process memory in MB with one decimal, or `n/a`. */
export function formatMemory(sample: MemorySample): string {
  const mb = (bytes: number | null): string => (bytes === null ? 'n/a' : (bytes / (1024 * 1024)).toFixed(1));
  return `[dev] memory: rss=${mb(sample.rss)} heapUsed=${mb(sample.heapUsed)} heapTotal=${mb(sample.heapTotal)} external=${mb(sample.external)}`;
}

export interface DevHomey {
  ble: BleManagerLike;
  settings: {
    on(event: 'set', listener: (key: string) => void): unknown;
    get(key: string): unknown;
  };
}

interface Running {
  manager: ConnectionManager;
  fault: FaultTransport;
}

/** The link of a paired device, registered under DEBUG=1 so the harness can act on it. */
export interface DevLink extends Running {
  /** Identifies the device in log lines (its BLE uuid). */
  label: string;
}

const devLinks: DevLink[] = [];
/** Stops the harness's own link (set by `registerDevHarness`). */
let stopOwnLink: (() => Promise<void>) | null = null;

/**
 * A device announces its link. The harness's own link is stopped first (one BLE connection at most), so call this and
 * await it before the device's link starts.
 */
export async function attachDevLink(link: DevLink): Promise<void> {
  if (!devLinks.includes(link)) devLinks.push(link);
  await stopOwnLink?.();
}

export function detachDevLink(link: DevLink): void {
  const i = devLinks.indexOf(link);
  if (i >= 0) devLinks.splice(i, 1);
}

export function registerDevHarness(
  homey: DevHomey,
  log: (message: string) => void,
  memory: MemorySource = processMemory,
): void {
  let running: Running | null = null;
  let chain: Promise<void> = Promise.resolve();

  stopOwnLink = async () => {
    const own = running;
    if (!own) return;
    running = null;
    await own.manager.stop();
    log('[dev] harness link stopped: device took over');
  };

  const execute = async (command: DevCommand): Promise<void> => {
    const device = devLinks[0];
    if (command.kind === 'mem') return log(formatMemory(readMemory(memory)));
    if (command.kind === 'connect') {
      if (device) return log(`[dev] connect refused: device ${device.label} owns the BLE link`);
      if (running) return log('[dev] already connected, use stop first');
      // Scans for up to TIMEBOX_DISCOVERY_TIMEOUT_MS; a discovery failure is reported as such, not as a transport error.
      let found;
      try {
        found = await discoverTimeboxes(homey.ble);
      } catch (e) {
        if (e instanceof DiscoveryError) return log(`[dev] ${e.message}`);
        throw e;
      }
      // A device may have attached while the scan was running.
      if (devLinks[0]) return log(`[dev] connect refused: device ${devLinks[0].label} owns the BLE link`);
      if (running) return log('[dev] already connected, use stop first');
      const fault = new FaultTransport(new BleTransport(homey.ble, found[0].uuid, log));
      const manager = new ConnectionManager(fault, { log, error: log });
      running = { manager, fault };
      log(`[dev] using ${found[0].localName} (${found[0].uuid})`);
      manager.start();
      return;
    }
    if (device && command.kind === 'stop') {
      return log(`[dev] stop refused: device ${device.label} owns the BLE link`);
    }
    const target: Running | undefined = device ?? running ?? undefined;
    if (!target) return log('[dev] not started, send connect first');
    const { manager, fault } = target;
    switch (command.kind) {
      case 'drop':
        return fault.drop();
      case 'mute':
        fault.mute();
        return log('[dev] muted until the next reconnect');
      case 'poll':
        manager.setPollInterval(command.seconds * 1000);
        return log(`[dev] poll interval ${command.seconds}s`);
      case 'stop':
        running = null;
        return manager.stop();
      case 'brightness': {
        await manager.send(setBrightness(command.percent));
        const status = decodeStatus(await manager.request(queryStatus(), 0x46));
        return log(`[dev] status: brightness=${status.brightness} channel=${status.channel}`);
      }
      case 'channel': {
        const frame = setChannel(command.code);
        await manager.send(frame);
        return log(`[dev] channel command sent: ${toHex(frame)}`);
      }
      case 'time': {
        const { year, month, day, hour, minute } = command.parts;
        await manager.request(setDateTime(command.parts), 0x18);
        const two = (n: number): string => String(n).padStart(2, '0');
        return log(`[dev] time set to ${year}-${two(month)}-${two(day)} ${two(hour)}:${two(minute)}:00`);
      }
      case 'calendar':
        await manager.send(CALENDAR_CLOCK);
        return log('[dev] calendar clock view sent');
    }
  };

  homey.settings.on('set', (key: string) => {
    if (key !== DEV_SETTING_KEY) return;
    const raw = homey.settings.get(DEV_SETTING_KEY);
    const command = parseDevCommand(raw);
    if (!command) {
      log(`[dev] ignored invalid command: ${JSON.stringify(raw)}`);
      return;
    }
    log(
      `[dev] command: ${command.kind}${'percent' in command ? `:${command.percent}` : ''}${'seconds' in command ? `:${command.seconds}` : ''}${'code' in command ? `:${command.code}` : ''}`,
    );
    chain = chain
      .then(() => execute(command))
      .catch((e: unknown) =>
        log(`[dev] command ${command.kind} failed: ${e instanceof Error ? e.message : String(e)}`),
      );
  });
  log('[dev] harness ready');
}
