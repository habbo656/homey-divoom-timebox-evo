// Pairing logic (issue #46, pairing part of #22). No Homey imports: the BLE manager and the pair session are injected
// through structural types, so everything here is unit tested with fakes. The pair view (drivers/timebox/pair/scan.html)
// drives it with events; see docs/architecture.md "Pairing".
import type { DeviceStatus } from '../protocol/status';
import {
  BleTransport,
  DiscoveryError,
  normaliseUuid,
  scanPeripherals,
  SERVICE_UUID,
  TIMEBOX_DISCOVERY_TIMEOUT_MS,
} from '../transport/BleTransport';
import type { BleAdvertisementLike, BleManagerLike, ScanOptions } from '../transport/BleTransport';
import { ConnectionManager } from '../transport/ConnectionManager';
import { TransportError } from '../transport/Transport';
import type { LinkHandlers, Transport } from '../transport/Transport';

/** Length of one pairing scan (the Evo alternates its advertised name, a short scan can miss it). */
export const PAIR_SCAN_TIMEOUT_MS = TIMEBOX_DISCOVERY_TIMEOUT_MS;
/** Upper bound for verifying the chosen device (connect, GATT discovery, first `46` status reply). */
export const PAIR_VERIFY_TIMEOUT_MS = 45_000;
/** Most candidates offered (matching devices come first and are never cut off by non-matching ones). */
export const PAIR_MAX_CANDIDATES = 30;
/** Candidates written to the log after a scan. */
const LOG_TOP_CANDIDATES = 5;
/**
 * Name rule of the pair list: the Evo advertises only its local name (`TimeBox-Evo-light` / `TimeBox-Evo-audio`, no
 * service UUIDs, no manufacturer data; docs/divoom-protocol.md section 1.1). Case-insensitive.
 */
export const PAIR_NAME_PATTERN = /timebox|divoom|evo/i;

export interface PairCandidate {
  /** Peripheral UUID as reported by Homey; becomes `data.id`. */
  id: string;
  /** The advertised local name (never empty: unnamed devices are not candidates). Untrusted text: the view must render it with `textContent`. */
  name: string;
  address: string;
  /** For sorting and logging only; the view does not show it. */
  rssi: number;
  /** Looks like a Timebox: the name matches `PAIR_NAME_PATTERN` or the peripheral advertises the ISSC service. Shown by default; the others only with "Show all devices". */
  match: boolean;
  /** The peripheral advertises the Evo's ISSC service `49535343-fe7d-...` (extra positive signal; the Evo itself does not). */
  issc: boolean;
  serviceUuids: string[];
}

const isIssc = (serviceUuids: string[]): boolean =>
  serviceUuids.some((u) => normaliseUuid(u) === normaliseUuid(SERVICE_UUID));

/**
 * Candidates for the pair list. Peripherals are de-duplicated by UUID (latest RSSI, last non-empty name, union of the
 * advertised service UUIDs). Unnamed peripherals are dropped, as are already paired ids. The rest is flagged `match`
 * (name rule or ISSC service) and ordered: matching devices first (strongest signal first), then the others
 * alphabetically. The view shows only the matching ones until "Show all devices" is pressed (renamed units).
 */
export function selectCandidates(
  advertisements: BleAdvertisementLike[],
  pairedIds: readonly string[] = [],
): PairCandidate[] {
  const byId = new Map<string, PairCandidate>();
  for (const ad of advertisements) {
    if (typeof ad.uuid !== 'string' || ad.uuid === '') continue;
    const key = normaliseUuid(ad.uuid);
    const previous = byId.get(key);
    const serviceUuids = Array.isArray(ad.serviceUuids) ? ad.serviceUuids.filter((u) => typeof u === 'string') : [];
    const merged = [...new Set([...(previous?.serviceUuids ?? []), ...serviceUuids])];
    const name = (typeof ad.localName === 'string' && ad.localName.trim() !== '' ? ad.localName : previous?.name) ?? '';
    const address = (typeof ad.address === 'string' && ad.address !== '' ? ad.address : previous?.address) ?? '';
    const issc = isIssc(merged);
    byId.set(key, {
      id: ad.uuid,
      name,
      address,
      rssi: typeof ad.rssi === 'number' ? ad.rssi : (previous?.rssi ?? 0),
      match: issc || PAIR_NAME_PATTERN.test(name),
      issc,
      serviceUuids: merged,
    });
  }
  const paired = new Set(pairedIds.map(normaliseUuid));
  const named = [...byId.values()].filter((c) => c.name !== '' && !paired.has(normaliseUuid(c.id)));
  const byName = (a: PairCandidate, b: PairCandidate): number =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase()) ||
    a.name.localeCompare(b.name) ||
    a.id.localeCompare(b.id);
  return [
    ...named.filter((c) => c.match).sort((a, b) => b.rssi - a.rssi || byName(a, b)),
    ...named.filter((c) => !c.match).sort(byName),
  ].slice(0, PAIR_MAX_CANDIDATES);
}

// --- verify -------------------------------------------------------------------------------------------------------

export type VerifyResult = { ok: true; status: DeviceStatus } | { ok: false; reason: 'not_timebox' | 'timeout' };

export interface VerifyOptions {
  /** Default `PAIR_VERIFY_TIMEOUT_MS`. */
  timeoutMs?: number;
  log?: (message: string) => void;
  /** Aborting ends the verification early (reported as `timeout`; nobody listens any more). */
  signal?: AbortSignal;
}

/**
 * Connect to `uuid` and wait for the first `46` status reply (the ConnectionManager polls once on connect): the device
 * then has the ISSC characteristics and speaks the protocol. A permanent transport error (no ISSC service/characteristics)
 * fails fast as `not_timebox`; anything else that does not answer in time is `timeout`. The link is always closed.
 */
export async function verifyTimebox(
  ble: BleManagerLike,
  uuid: string,
  options: VerifyOptions = {},
): Promise<VerifyResult> {
  const timeoutMs = options.timeoutMs ?? PAIR_VERIFY_TIMEOUT_MS;
  const log = options.log ?? (() => undefined);
  let wake: (() => void) | null = null;
  const inner = new BleTransport(ble, uuid, log);
  const transport: Transport = {
    async open(handlers: LinkHandlers) {
      try {
        await inner.open(handlers);
      } catch (e) {
        if (e instanceof TransportError && e.permanent) {
          wake?.();
        }
        throw e;
      }
    },
    write: (bytes) => inner.write(bytes),
    close: () => inner.close(),
  };
  // Poll every 10 s (the minimum) so a lost first reply does not use up the whole verification.
  const manager = new ConnectionManager(transport, {
    log,
    error: log,
    pollIntervalMs: 10_000,
    requestTimeoutMs: 8_000,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const outcome = new Promise<VerifyResult>((resolve) => {
      wake = () => resolve({ ok: false, reason: 'not_timebox' });
      manager.once('status', (status) => resolve({ ok: true, status }));
      timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), timeoutMs);
      onAbort = () => resolve({ ok: false, reason: 'timeout' });
      if (options.signal?.aborted) onAbort();
      else options.signal?.addEventListener('abort', onAbort, { once: true });
    });
    manager.start();
    return await outcome;
  } finally {
    clearTimeout(timer);
    if (onAbort) options.signal?.removeEventListener('abort', onAbort);
    await manager.stop();
  }
}

// --- pair session -------------------------------------------------------------------------------------------------

/** The part of Homey's `PairSession` that is used. */
export interface PairSessionLike {
  setHandler(event: string, handler: (data?: unknown) => Promise<unknown>): unknown;
  emit(event: string, data: unknown): Promise<unknown>;
}

export interface PairDeps {
  ble: BleManagerLike;
  /** Ids (`data.id`) of the devices that are already paired; read at the start of every scan. */
  pairedIds: () => string[];
  log: (message: string) => void;
  /** Overrides for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  scanTimeoutMs?: number;
  scanSliceMs?: number;
  minSliceMs?: number;
  verifyTimeoutMs?: number;
}

/** `scan_update` event: pushed after every scan slice and when the scan ends. */
export interface ScanUpdate {
  candidates: PairCandidate[];
  state: 'scanning' | 'done' | 'failed';
  elapsedMs: number;
  durationMs: number;
  error?: string;
}

/** `verify_result` event. */
export interface VerifyUpdate {
  ok: boolean;
  device?: { name: string; data: { id: string } };
  reason?: 'not_timebox' | 'timeout';
}

interface ScanRun {
  cancelled: boolean;
  done: Promise<void>;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const seconds = (ms: number): number => Math.round(ms / 1000);

/**
 * Wires the pair view events to the scan and the verification. `scan` and `verify` return at once and push their
 * results with `scan_update` / `verify_result`, so no handler runs for the 60 s of a scan (no handler timeout) and the
 * view can offer a real "Search again".
 */
export function registerPairHandlers(session: PairSessionLike, deps: PairDeps): void {
  const log = (m: string): void => deps.log(`[pair] ${m}`);
  const now = deps.now ?? Date.now;
  const durationMs = deps.scanTimeoutMs ?? PAIR_SCAN_TIMEOUT_MS;
  let scan: ScanRun | null = null;
  let verifying: { abort: AbortController; done: Promise<void> } | null = null;
  let generation = 0;
  let closed = false;
  /** Names of every named device the latest scan saw (paired ones included), for the created device. */
  const names = new Map<string, string>();

  const emit = (event: string, data: unknown): void => {
    try {
      session.emit(event, data).catch(() => undefined);
    } catch {
      // The view is gone; nothing to tell.
    }
  };

  /** Cancel the running scan and wait until its in-flight slice has returned. */
  const stopScan = async (): Promise<void> => {
    const running = scan;
    if (!running) return;
    running.cancelled = true;
    await running.done;
    if (scan === running) scan = null;
  };

  const runScan = async (run: ScanRun): Promise<void> => {
    let paired: string[] = [];
    const seen: BleAdvertisementLike[] = [];
    try {
      paired = deps.pairedIds();
      names.clear();
      log(`scan started (${seconds(durationMs)} s)`);
      const options: ScanOptions = {
        timeoutMs: durationMs,
        scanMs: deps.scanSliceMs,
        minSliceMs: deps.minSliceMs,
        now,
        sleep: deps.sleep,
        isCancelled: () => run.cancelled,
        onSlice: (ads, elapsedMs) => {
          seen.push(...ads);
          const issc = ads.filter((a) => isIssc(Array.isArray(a.serviceUuids) ? a.serviceUuids : [])).length;
          log(`slice: ${ads.length} peripherals, ${issc} advertise ISSC`);
          for (const c of selectCandidates(seen)) names.set(normaliseUuid(c.id), c.name);
          const candidates = selectCandidates(seen, paired);
          emit('scan_update', { state: 'scanning', elapsedMs, durationMs, candidates } satisfies ScanUpdate);
        },
      };
      const result = await scanPeripherals(deps.ble, options);
      if (result.ended === 'cancelled') return;
      const candidates = selectCandidates(seen, paired);
      const matching = candidates.filter((c) => c.match);
      log(
        `scan finished after ${seconds(result.elapsedMs)} s: ${matching.length} matching, ${candidates.length - matching.length} other named device(s)`,
      );
      for (const c of candidates.slice(0, LOG_TOP_CANDIDATES)) {
        log(
          `candidate uuid=${c.id} name=${JSON.stringify(c.name)} match=${c.match} rssi=${c.rssi} issc=${c.issc} serviceUuids=${c.serviceUuids.join(',') || '-'}`,
        );
      }
      emit('scan_update', { state: 'done', elapsedMs: result.elapsedMs, durationMs, candidates } satisfies ScanUpdate);
    } catch (e) {
      if (run.cancelled) return;
      const elapsedMs = e instanceof DiscoveryError ? e.scannedMs : 0;
      log(`scan failed: ${message(e)}`);
      emit('scan_update', {
        state: 'failed',
        elapsedMs,
        durationMs,
        candidates: selectCandidates(seen, paired),
        error: message(e),
      } satisfies ScanUpdate);
    }
  };

  /** The running verification; `done` never rejects. */
  const stopVerify = async (): Promise<void> => {
    const running = verifying;
    if (!running) return;
    running.abort.abort();
    await running.done;
  };

  const runVerify = async (id: string, abort: AbortController): Promise<void> => {
    let update: VerifyUpdate;
    try {
      const result = await verifyTimebox(deps.ble, id, {
        timeoutMs: deps.verifyTimeoutMs,
        log: deps.log,
        signal: abort.signal,
      });
      if (result.ok) {
        log(`verified ${id}: brightness=${result.status.brightness} channel=${result.status.channel}`);
        update = { ok: true, device: { name: names.get(normaliseUuid(id)) ?? id, data: { id } } };
      } else {
        log(`verify failed ${id}: ${result.reason}`);
        update = { ok: false, reason: result.reason };
      }
    } catch (e) {
      log(`verify failed ${id}: ${message(e)}`);
      update = { ok: false, reason: 'timeout' };
    }
    if (verifying?.abort === abort) verifying = null;
    if (!abort.signal.aborted) emit('verify_result', update);
  };

  // Every handler takes a generation number before it awaits; after the awaits only the newest one may start work, and
  // nothing starts once the session is closed. This makes overlapping `scan`/`verify` calls cancel each other (the older
  // one never starts) and keeps a scan and a verification from running at the same time.
  const startVerify = async (id: string): Promise<void> => {
    const mine = ++generation;
    await stopVerify();
    await stopScan();
    if (closed || mine !== generation) return;
    const abort = new AbortController();
    verifying = { abort, done: runVerify(id, abort).catch(() => undefined) };
  };

  session.setHandler('scan', async () => {
    const mine = ++generation;
    await stopVerify();
    await stopScan();
    if (closed || mine !== generation) return { durationMs };
    const run: ScanRun = { cancelled: false, done: Promise.resolve() };
    scan = run;
    run.done = runScan(run).catch(() => undefined);
    return { durationMs };
  });

  session.setHandler('verify', async (data) => {
    const id = (data as { id?: unknown } | undefined)?.id;
    if (typeof id !== 'string' || id === '') throw new Error('verify: missing device id');
    void startVerify(id);
    return { started: true };
  });

  session.setHandler('disconnect', async () => {
    closed = true;
    generation++;
    await stopVerify();
    await stopScan();
  });
}
