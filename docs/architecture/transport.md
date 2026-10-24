# Transport

_Part of [architecture](../architecture.md); moved from "Transport" (#120)._

- **Transport** (`src/transport/`) — two layers:
  - `Transport` (interface): `open(handlers)`, `write(bytes)` (one GATT write), `close()`; `handlers = { onData, onClose }`.
    `open` resolves only when notifications are already subscribed. A `TransportError` with `permanent: true` means
    "do not retry quickly" (e.g. GATT service missing). `BleTransport` implements it on `homey.ble` (Homey is
    imported as a type only; the BLE manager is injected as the structural `BleManagerLike`), `MockTransport` is the
    in-memory test double. `scanPeripherals(ble, options)` is the shared scan loop: it calls `ble.discover` in 10 s slices
    (`TIMEBOX_DISCOVERY_SCAN_MS`) for the whole budget (60 s, `TIMEBOX_DISCOVERY_TIMEOUT_MS`), hands every slice to
    `onSlice(advertisements, elapsedMs)` and ends early only when `onSlice` returns `true` or `isCancelled()` is true
    (checked between slices, so a cancel takes effect after at most one slice; the slice that finished meanwhile is
    dropped). A slice that returns early is padded with a pause to at least 1 s (`TIMEBOX_DISCOVERY_MIN_SLICE_MS`), so the
    loop cannot spin. A failing slice throws `DiscoveryError` (not a `TransportError`): `discovery: scan failed after N s:
    <msg>`. Time is injectable (`now`, `sleep`) for tests. `discoverTimeboxes(ble)` (dev harness only) is built on it:
    it stops at the first slice that sees a `/timebox/i` advertisement (strongest RSSI first) and throws
    `DiscoveryError` `discovery: no Timebox found after 60 s` when the budget is spent. Pairing does not use the name
    (see "Pairing"). `BleAdvertisementLike` carries the optional `address` and `serviceUuids` that Homey provides.
    Notifications are de-duplicated per link: Homey invoked the callback 5 times per notification in the #21 hardware
    run (protocol section 10), so `BleTransport` drops a notification whose bytes equal the previous one when it is the
    same Buffer object (within `BLE_DUPLICATE_SAME_BUFFER_WINDOW_MS`, 1 s, so a reused Buffer cannot swallow later identical
    replies) or arrives within `BLE_DUPLICATE_NOTIFY_WINDOW_MS` (20 ms, `BleTransportOptions.now` for tests);
    the state is created per attempt, so a reconnect starts clean. The app registers the callback once per attempt
    (one `subscribeToNotifications`, gated by `attempt.cancelled`; `ConnectionManager.onData` only accepts the current
    session; `FaultTransport` passes data through), so the duplicates come from Homey.
    `BleTransport` opens one after another: the next `open` waits for the previous connect/close, but for at most 10 s
    (`BLE_OPEN_WAIT_MS`), and every `peripheral.disconnect()` is bounded by 5 s (`BLE_DISCONNECT_TIMEOUT_MS`); both are
    `BleTransportOptions`. A BLE call that never settles therefore cannot block reconnection for longer than these
    bounds. A stale attempt that finishes after that does not disconnect while a newer attempt is connecting or
    connected (both use the same device, so its disconnect could drop the new link); it removes its own listener and
    hands its peripheral, plus the orphans it holds itself, over to the newer attempt (`Attempt.orphans`, #48). The
    newer attempt disconnects them, in parallel under one `disconnectTimeoutMs` bound and each object once, when its
    own link is torn down (`close()`, the next `open`, or a failure before it got a peripheral), so a stale connection
    never loses its owner whether or not Homey keeps one connection per UUID. A newer attempt that has not started
    yet takes nothing over: the orphans are disconnected at once. The timing options of `BleTransport`
    (`openWaitMs`, `disconnectTimeoutMs`) and of `ConnectionManager` (`connectTimeoutMs`, `closeTimeoutMs`) are
    validated when passed explicitly (`assertTimerMs` in `settle.ts`): anything but an integer within 1..2^31-1 ms
    throws a `RangeError` naming the option from the constructor; `undefined` keeps the default.
    Decided in #48 and accepted: a late stale release that finds no started newer attempt is not tracked by the open
    serialisation (an `open` waits at most `openWaitMs` for a BLE call that hung), so its bounded disconnect (at most
    `disconnectTimeoutMs`) can overlap the next connect. This needs a BLE call that hung for longer than 10 s; at worst
    it costs one failed connect or one dropped fresh link, which backoff and polling recover. Chaining the previous run
    into the next `open` was rejected: a call that hangs for ever would delay every open by the full wait.
  - `ConnectionManager` (no Homey imports) owns one `Transport` and keeps the link alive. Per connection it creates a
    fresh `SequenceCounter`, an empty receive buffer and a session object (callbacks of an older session are ignored).
    `send(payload)` wraps the payload in the envelope when its turn in a serialised queue comes (so sequence numbers
    follow the write order) and writes it in 20-byte chunks; `request(payload, expectCmd, timeoutMs?, accept?)` additionally
    waits for the device frame with that opcode (waiter registered before the write; a timeout clears the receive
    buffer). The optional `accept(reply)` predicate (#101) narrows the match: a frame with the right opcode that `accept`
    refuses does not answer the request (it stays a `reply` event for everyone else and the waiter keeps waiting until
    its timeout); a throwing predicate counts as "not accepted" and is logged (`[link] reply filter threw for opcode …`).
    Used for opcodes the device also sends unsolicited (`bd`, see custom-pages.md). `send`/`request` reject with `NotConnectedError` without a live link, with `RequestTimeoutError` on
    timeout and with `LinkLostError` if the link is lost or the manager stopped while pending. A write error counts as
    link loss. `request` rejects (never throws) with `RangeError` for an `expectCmd` outside u8 or a timeout that is not
    an integer within 1..2^31-1 ms. The request timeout counts from the call, i.e. it includes time spent in the send queue (revisit with
    the image issues, where long chunk sequences precede a request). The next `Transport.open` waits for the previous
    `Transport.close()`, so a late disconnect cannot hit the new connection; that wait, and the one in `stop()`, is
    bounded by `closeTimeoutMs` (default 10 s), so a hung close cannot block reconnecting or stopping. Events: `state`,
    `connected`, `disconnected(reason)` (only after `connected` was emitted; a `state` listener that stops the manager
    on `connected` gets neither), `reply(Reply)`, `status(DeviceStatus)`.
    Liveness: a `46` poll right after connecting, then every `pollIntervalMs` (default 60 s, `setPollInterval(ms)`
    accepts 10 s..1 h). Only the answer to the poll counts (`f7` heartbeats do not); 2 consecutive misses declare the
    link dead and reconnect. Reconnect backoff: `cap = min(60 s, 2 s * 2^attempt)`, `delay = cap/2 + random*cap/2`;
    the attempt counter resets on every successful poll. A permanent `TransportError` retries
    every 5 min. Connecting is bounded by 30 s (this includes the bounded waits above). Defaults are constructor options (`ConnectionManagerOptions`).

Log prefixes (one line per event, easy to grep in `homey app run` output): `[link]` ConnectionManager (`connecting
(attempt N)`, `connected (seq reset)`, `connect failed: <msg>; retry in Ns`, `permanent error: ...`, `disconnected:
<reason>`, `poll ok: brightness=B channel=C`, `poll timeout (n/2)`, `poll invalid reply: <msg> (n/2)`, `link dead, reconnecting`, `reconnecting in Ns`,
`rx <hex>` for every notification, `rx skipped N garbage byte(s)`, `close did not finish within Ns; continuing`; errors:
`dropped malformed frame: <msg>`, `listener for "<event>" threw: <msg>`), `[ble]` BleTransport (`services: ...` once per
successful connect and when the Evo GATT layout is missing, `duplicate notification dropped (Homey delivered it more than
once)` once per link, `previous connect/disconnect still pending after Ns; opening anyway`, `disconnect did
not finish within Ns; continuing`, `stale connect finished late; not disconnecting (a newer attempt owns the link)`,
`disconnecting a stale connection left by an earlier attempt`),
`[pair]` pairing (see "Pairing"), `[dev]` dev harness.
