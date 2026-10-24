// Bounded waiting for promises that may never settle (a hung BLE call must not wedge the link forever).

/**
 * Waits until `promise` settles (fulfilled or rejected) or `ms` elapse, whichever comes first. Resolves `true` if the
 * promise settled in time, `false` on timeout; never rejects. The timer is cleared as soon as the promise settles, so
 * no timer outlives a promise that settles normally.
 */
export function settleWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    const done = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    promise.then(done, done);
  });
}

/** Largest delay `setTimeout` accepts (2^31 - 1 ms); larger values fire immediately. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/** Throws a `RangeError` naming the option unless `ms` is an integer within 1..`MAX_TIMER_MS` (a valid timer delay). */
export function assertTimerMs(name: string, ms: number): void {
  if (!Number.isInteger(ms) || ms < 1 || ms > MAX_TIMER_MS) {
    throw new RangeError(`${name} must be an integer within 1..${MAX_TIMER_MS} ms, got ${ms}`);
  }
}
