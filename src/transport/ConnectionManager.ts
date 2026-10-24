// Link supervision on top of a `Transport` (docs/architecture.md): envelope + sequence counter, 20-byte chunking, a
// serialised send queue, request/reply matching, `46` status polling as the liveness check and reconnects with
// jittered backoff. No Homey imports; everything hardware-specific is behind `Transport`.
import { EventEmitter } from 'node:events';
import { queryStatus } from '../protocol/commands';
import { envelope, SequenceCounter } from '../protocol/envelope';
import { toHex } from '../protocol/hex';
import { decodeSppFrame, parseReply, splitFrames } from '../protocol/replies';
import type { Reply } from '../protocol/replies';
import { decodeStatus } from '../protocol/status';
import type { DeviceStatus } from '../protocol/status';
import { chunk } from './chunk';
import { LinkLostError, NotConnectedError, RequestTimeoutError } from './errors';
import { assertTimerMs, MAX_TIMER_MS, settleWithin } from './settle';
import { TransportError } from './Transport';
import type { Transport } from './Transport';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected';

export interface ConnectionManagerOptions {
  /** Interval of the `46` liveness poll (default 60 s). */
  pollIntervalMs?: number;
  /** How long `request` waits for its reply (default 5 s). */
  requestTimeoutMs?: number;
  /** Upper bound for `Transport.open` (default 30 s). */
  connectTimeoutMs?: number;
  /** Upper bound for waiting on `Transport.close()` before the next open or the end of `stop()` (default 10 s). */
  closeTimeoutMs?: number;
  /** Backoff after a failed connect or a lost link: cap = min(max, base * 2^attempt), delay = cap/2 + random * cap/2. */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Retry delay after a permanent `TransportError` (default 5 min). */
  permanentRetryMs?: number;
  /** Consecutive unanswered polls that declare the link dead (default 2). */
  maxMissedPolls?: number;
  /** Injected for deterministic tests (default `Math.random`). */
  random?: () => number;
  log?: (message: string) => void;
  error?: (message: string) => void;
}

export interface ConnectFailure {
  reason: string;
  permanent: boolean;
  retryInMs: number;
}

export interface ConnectionManagerEvents {
  state: [state: ConnectionState];
  connected: [];
  disconnected: [reason: string];
  /**
   * A connect attempt failed (never emitted for a lost link of an established session, nor after `stop()`).
   * `permanent` means a permanent `TransportError` (e.g. wrong device); `retryInMs` is the delay until the next try.
   */
  connectFailed: [info: ConnectFailure];
  /** Every well-formed device frame (replies and unsolicited notifications). */
  reply: [reply: Reply];
  /** Every decodable `46` status reply. */
  status: [status: DeviceStatus];
}

export const MIN_POLL_INTERVAL_MS = 10_000;
export const MAX_POLL_INTERVAL_MS = 3_600_000;

interface Waiter {
  cmd: number;
  /** Optional filter: a frame with the right opcode that this rejects does not answer the request. */
  accept?: (reply: Reply) => boolean;
  resolve: (reply: Reply) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** State of exactly one connection attempt/connection. Replaced (never reused) on every reconnect. */
class Session {
  readonly seq = new SequenceCounter();
  rx: Uint8Array = new Uint8Array(0);
  queue: Promise<void> = Promise.resolve();
  waiters: Waiter[] = [];
  pending = new Set<(error: Error) => void>();
  dead = false;
  connected = false;
  /** The `connected` event was emitted; only then does the end of the session emit `disconnected`. */
  announced = false;
  missedPolls = 0;
  pollInFlight = false;
  connectTimer: ReturnType<typeof setTimeout> | null = null;
  pollTimer: ReturnType<typeof setInterval> | null = null;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class ConnectionManager extends EventEmitter<ConnectionManagerEvents> {
  private readonly transport: Transport;
  private pollIntervalMs: number;
  private readonly requestTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly permanentRetryMs: number;
  private readonly maxMissedPolls: number;
  private readonly random: () => number;
  private readonly logFn: (message: string) => void;
  private readonly errorFn: (message: string) => void;

  private running = false;
  private current: Session | null = null;
  private currentState: ConnectionState = 'disconnected';
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Settles when the last `transport.close()` is done or `closeTimeoutMs` after it started, whichever comes first; the
   * next `open` and `stop()` wait for it. Never rejects.
   */
  private closing: Promise<void> = Promise.resolve();

  constructor(transport: Transport, options: ConnectionManagerOptions = {}) {
    super();
    this.transport = transport;
    this.pollIntervalMs = options.pollIntervalMs ?? 60_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 30_000;
    this.closeTimeoutMs = options.closeTimeoutMs ?? 10_000;
    this.backoffBaseMs = options.backoffBaseMs ?? 2_000;
    this.backoffMaxMs = options.backoffMaxMs ?? 60_000;
    this.permanentRetryMs = options.permanentRetryMs ?? 300_000;
    this.maxMissedPolls = options.maxMissedPolls ?? 2;
    this.random = options.random ?? Math.random;
    this.logFn = options.log ?? (() => undefined);
    this.errorFn = options.error ?? (() => undefined);
    this.validatePollInterval(this.pollIntervalMs);
    if (options.connectTimeoutMs !== undefined) assertTimerMs('connectTimeoutMs', options.connectTimeoutMs);
    if (options.closeTimeoutMs !== undefined) assertTimerMs('closeTimeoutMs', options.closeTimeoutMs);
  }

  get state(): ConnectionState {
    return this.currentState;
  }

  /** Start connecting (and keep reconnecting) until `stop()`. Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.attempt = 0;
    this.connect();
  }

  /**
   * Stop for good: cancels timers, rejects pending calls with `LinkLostError`, closes the transport. Resolves once the
   * close is done, or after `closeTimeoutMs` if it hangs.
   */
  async stop(): Promise<void> {
    this.running = false;
    this.clearReconnectTimer();
    await this.endSession('stopped');
    await this.closing;
  }

  /** Change the liveness poll interval (10 s..1 h). Takes effect immediately for the live connection. */
  setPollInterval(ms: number): void {
    this.validatePollInterval(ms);
    this.pollIntervalMs = ms;
    const session = this.current;
    if (session?.connected && !session.dead) this.armPollTimer(session);
  }

  /** Send a command payload (opcode + args). Resolves when all chunks are written; the Evo does not acknowledge. */
  send(payload: Uint8Array): Promise<void> {
    const session = this.liveSession();
    if (!session) return Promise.reject(new NotConnectedError());
    return this.enqueue(session, payload);
  }

  /**
   * Send a command and wait for the device frame with opcode `expectCmd`. Every error is a rejection (never a throw).
   * With `accept`, only a frame with that opcode for which `accept` returns true answers; other frames stay
   * `reply` events and the request keeps waiting (for opcodes the device also sends unsolicited, e.g. `bd`). A throwing
   * `accept` counts as "not accepted" and is logged.
   */
  request(
    payload: Uint8Array,
    expectCmd: number,
    timeoutMs = this.requestTimeoutMs,
    accept?: (reply: Reply) => boolean,
  ): Promise<Reply> {
    if (!Number.isInteger(expectCmd) || expectCmd < 0 || expectCmd > 0xff) {
      return Promise.reject(new RangeError(`expected opcode must be a u8, got ${expectCmd}`));
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMER_MS) {
      return Promise.reject(
        new RangeError(`request timeout must be an integer within 1..${MAX_TIMER_MS} ms, got ${timeoutMs}`),
      );
    }
    const session = this.liveSession();
    if (!session) return Promise.reject(new NotConnectedError());
    return this.requestOn(session, payload, expectCmd, timeoutMs, accept);
  }

  // --- connecting -------------------------------------------------------------------------------------------------

  private connect(): void {
    if (!this.running || this.current) return;
    const session = new Session();
    this.current = session;
    this.setState('connecting');
    this.log(`connecting (attempt ${this.attempt + 1})`);

    session.connectTimer = setTimeout(() => {
      session.connectTimer = null;
      this.connectFailed(session, new TransportError(`timeout after ${Math.round(this.connectTimeoutMs / 1000)}s`));
    }, this.connectTimeoutMs);

    // Wait for the previous close() (bounded, see `closing`), so a late disconnect cannot hit the new connection. The
    // deferred call also turns a synchronous throw of `open` into a rejection.
    this.closing
      .then(() => {
        if (session.dead) throw new TransportError('cancelled before open');
        return this.transport.open({
          onData: (bytes) => this.onData(session, bytes),
          onClose: () => this.onClose(session),
        });
      })
      .then(
        () => this.onOpen(session),
        (e: unknown) => this.connectFailed(session, e),
      );
  }

  private onOpen(session: Session): void {
    if (session.dead || this.current !== session) return;
    if (session.connectTimer) clearTimeout(session.connectTimer);
    session.connectTimer = null;
    session.connected = true;
    this.setState('connected');
    if (session.dead) return; // a state listener ended the session before `connected` was announced
    this.log('connected (seq reset)');
    session.announced = true;
    this.safeEmit('connected');
    if (session.dead) return; // a listener called stop() or otherwise ended the session
    void this.poll(session);
    this.armPollTimer(session);
  }

  private connectFailed(session: Session, e: unknown): void {
    if (session.dead || this.current !== session) return;
    const permanent = e instanceof TransportError && e.permanent;
    void this.endSession(`connect failed: ${message(e)}`, session);
    if (!this.running) return;
    if (permanent) {
      this.log(`permanent error: ${message(e)}; retry in ${this.seconds(this.permanentRetryMs)}s`);
      this.scheduleReconnect(this.permanentRetryMs);
      this.safeEmit('connectFailed', { reason: message(e), permanent: true, retryInMs: this.permanentRetryMs });
    } else {
      const delay = this.nextBackoff();
      this.log(`connect failed: ${message(e)}; retry in ${this.seconds(delay)}s`);
      this.scheduleReconnect(delay);
      this.safeEmit('connectFailed', { reason: message(e), permanent: false, retryInMs: delay });
    }
  }

  private onClose(session: Session): void {
    this.lose(session, 'link closed by device');
  }

  /** The link of `session` is gone: tear it down and reconnect with backoff. */
  private lose(session: Session, reason: string, extraLog?: string): void {
    if (session.dead || this.current !== session) return;
    if (extraLog) this.log(extraLog);
    void this.endSession(reason, session);
    if (!this.running) return;
    const delay = this.nextBackoff();
    this.log(`reconnecting in ${this.seconds(delay)}s`);
    this.scheduleReconnect(delay);
  }

  /**
   * Mark the session dead, cancel its timers, reject everything pending and close the transport. Returns the close
   * promise (never rejects, settles after at most `closeTimeoutMs`). Emits `disconnected` if `connected` was emitted.
   */
  private endSession(reason: string, only?: Session): Promise<void> {
    const session = this.current;
    if (!session || (only && only !== session)) return Promise.resolve();
    this.current = null;
    session.dead = true;
    if (session.connectTimer) clearTimeout(session.connectTimer);
    if (session.pollTimer) clearInterval(session.pollTimer);
    session.connectTimer = null;
    session.pollTimer = null;
    const error = new LinkLostError(reason);
    const waiters = session.waiters;
    session.waiters = [];
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.reject(error);
    }
    const pending = [...session.pending];
    session.pending.clear();
    for (const reject of pending) reject(error);
    let closed: Promise<unknown>;
    try {
      closed = Promise.resolve(this.transport.close());
    } catch {
      closed = Promise.resolve();
    }
    // A close that never settles must not block the next open or stop() forever.
    const closing = settleWithin(closed, this.closeTimeoutMs).then((done) => {
      if (!done) this.log(`close did not finish within ${this.seconds(this.closeTimeoutMs)}s; continuing`);
    });
    this.closing = Promise.all([this.closing, closing]).then(() => undefined);
    this.setState('disconnected');
    if (session.announced) {
      this.log(`disconnected: ${reason}`);
      this.safeEmit('disconnected', reason);
    }
    return closing;
  }

  private nextBackoff(): number {
    const cap = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** this.attempt);
    this.attempt++;
    return cap / 2 + this.random() * (cap / 2);
  }

  private scheduleReconnect(delayMs: number): void {
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  // --- polling ----------------------------------------------------------------------------------------------------

  private armPollTimer(session: Session): void {
    if (session.pollTimer) clearInterval(session.pollTimer);
    session.pollTimer = setInterval(() => void this.poll(session), this.pollIntervalMs);
  }

  /** Only the answer to our own `46` query counts as liveness; `f7` heartbeats and other frames do not. */
  private async poll(session: Session): Promise<void> {
    if (session.dead || session.pollInFlight) return;
    session.pollInFlight = true;
    try {
      const reply = await this.requestOn(session, queryStatus(), 0x46, this.requestTimeoutMs);
      const status = decodeStatus(reply);
      session.missedPolls = 0;
      this.attempt = 0;
      this.log(`poll ok: brightness=${status.brightness} channel=${status.channel}`);
    } catch (e) {
      if (session.dead) return;
      if (e instanceof LinkLostError) return;
      session.missedPolls++;
      const detail = e instanceof RequestTimeoutError ? 'timeout' : `invalid reply: ${message(e)}`;
      this.log(`poll ${detail} (${session.missedPolls}/${this.maxMissedPolls})`);
      if (session.missedPolls >= this.maxMissedPolls) {
        this.lose(session, 'poll timeout', 'link dead, reconnecting');
      }
    } finally {
      session.pollInFlight = false;
    }
  }

  // --- sending ----------------------------------------------------------------------------------------------------

  private liveSession(): Session | null {
    const s = this.current;
    return s && s.connected && !s.dead ? s : null;
  }

  private requestOn(
    session: Session,
    payload: Uint8Array,
    cmd: number,
    timeoutMs: number,
    accept?: (reply: Reply) => boolean,
  ): Promise<Reply> {
    return new Promise<Reply>((resolve, reject) => {
      // Registered before the write so a fast reply cannot be missed.
      const waiter: Waiter = {
        cmd,
        accept,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.removeWaiter(session, waiter);
          session.rx = new Uint8Array(0);
          reject(
            new RequestTimeoutError(`no reply with opcode ${cmd.toString(16).padStart(2, '0')} within ${timeoutMs} ms`),
          );
        }, timeoutMs),
      };
      session.waiters.push(waiter);
      this.enqueue(session, payload).catch((e: unknown) => {
        if (!this.removeWaiter(session, waiter)) return;
        reject(e instanceof Error ? e : new Error(String(e)));
      });
    });
  }

  private removeWaiter(session: Session, waiter: Waiter): boolean {
    const i = session.waiters.indexOf(waiter);
    if (i < 0) return false;
    session.waiters.splice(i, 1);
    clearTimeout(waiter.timer);
    return true;
  }

  /** Append one envelope write to the session's queue; the sequence number is assigned when its turn comes. */
  private enqueue(session: Session, payload: Uint8Array): Promise<void> {
    const task = session.queue.then(async () => {
      if (session.dead) throw new LinkLostError();
      const bytes = envelope(payload, session.seq.next());
      try {
        for (const part of chunk(bytes)) {
          await this.transport.write(part);
          if (session.dead) throw new LinkLostError();
        }
      } catch (e) {
        if (e instanceof LinkLostError) throw e;
        const reason = `write failed: ${message(e)}`;
        this.lose(session, reason);
        throw new LinkLostError(reason);
      }
    });
    session.queue = task.catch(() => undefined);
    return new Promise<void>((resolve, reject) => {
      session.pending.add(reject);
      task.then(
        () => {
          session.pending.delete(reject);
          resolve();
        },
        (e: unknown) => {
          session.pending.delete(reject);
          reject(e);
        },
      );
    });
  }

  // --- receiving --------------------------------------------------------------------------------------------------

  private onData(session: Session, bytes: Uint8Array): void {
    if (session.dead || this.current !== session) return;
    this.log(`rx ${toHex(bytes)}`);
    const joined = new Uint8Array(session.rx.length + bytes.length);
    joined.set(session.rx, 0);
    joined.set(bytes, session.rx.length);
    const { frames, rest, skipped } = splitFrames(joined);
    session.rx = rest;
    if (skipped > 0) this.log(`rx skipped ${skipped} garbage byte(s)`);
    for (const frame of frames) {
      let reply: Reply;
      try {
        reply = parseReply(decodeSppFrame(frame));
      } catch (e) {
        this.errorFn(`[link] dropped malformed frame: ${message(e)}`);
        continue;
      }
      this.dispatch(session, reply);
    }
  }

  private dispatch(session: Session, reply: Reply): void {
    this.safeEmit('reply', reply);
    if (reply.cmd === 0x46) {
      try {
        this.safeEmit('status', decodeStatus(reply));
      } catch {
        // Not a usable status; a waiting poll decodes again and counts it as missed.
      }
    }
    const waiter = session.waiters.find((w) => w.cmd === reply.cmd && this.accepts(w, reply));
    if (waiter) {
      this.removeWaiter(session, waiter);
      waiter.resolve(reply);
    }
  }

  /** True if `waiter` takes `reply` (its opcode already matches). A throwing predicate refuses the frame. */
  private accepts(waiter: Waiter, reply: Reply): boolean {
    if (!waiter.accept) return true;
    try {
      return waiter.accept(reply);
    } catch (e) {
      this.log(`reply filter threw for opcode ${reply.cmd.toString(16).padStart(2, '0')}: ${message(e)}`);
      return false;
    }
  }

  // --- helpers ----------------------------------------------------------------------------------------------------

  private validatePollInterval(ms: number): void {
    if (!Number.isInteger(ms) || ms < MIN_POLL_INTERVAL_MS || ms > MAX_POLL_INTERVAL_MS) {
      throw new RangeError(
        `poll interval must be an integer within ${MIN_POLL_INTERVAL_MS}..${MAX_POLL_INTERVAL_MS} ms, got ${ms}`,
      );
    }
  }

  private setState(state: ConnectionState): void {
    if (this.currentState === state) return;
    this.currentState = state;
    this.safeEmit('state', state);
  }

  /** A throwing listener must never break the link logic. */
  private safeEmit<K extends keyof ConnectionManagerEvents>(event: K, ...args: ConnectionManagerEvents[K]): void {
    try {
      (this.emit as (name: string, ...rest: unknown[]) => boolean).call(this, event, ...args);
    } catch (e) {
      this.errorFn(`[link] listener for "${String(event)}" threw: ${message(e)}`);
    }
  }

  private seconds(ms: number): number {
    return Math.round(ms / 100) / 10;
  }

  private log(text: string): void {
    this.logFn(`[link] ${text}`);
  }
}
