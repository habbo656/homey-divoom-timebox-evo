// Automatic weather from Open-Meteo (docs/architecture.md, "Weather (#30)"): a small client for the current weather and
// the Homey-free `WeatherUpdater` that fetches it on a schedule and hands it on. No Homey imports; `fetch`, the location
// and the receiver are injected. Coordinates are never logged. Weather data by Open-Meteo.com (CC BY 4.0).
import { clampTemperature, wmoToCondition, type Weather } from './weather';

/** The request to Open-Meteo is given up after this long. */
export const OPEN_METEO_TIMEOUT_MS = 10_000;
/** After a failed update the next attempt waits at most this long (or the interval, if that is shorter). */
export const OPEN_METEO_RETRY_MS = 5 * 60 * 1000;

/** The part of `fetch` that is used (a global `fetch` fits). */
export type FetchLike = (
  url: string,
  init: { signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** The current weather as Open-Meteo reports it. */
export interface CurrentWeather {
  /** Degrees Celsius, not rounded. */
  temperatureC: number;
  /** WMO weather code. */
  weatherCode: number;
}

/** A failed request: timeout, HTTP error, network error or a response that is not what was asked for. */
export class OpenMeteoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenMeteoError';
  }
}

/** The request URL for a location (coordinates rounded to two decimals, about 1 km, for privacy). */
export function openMeteoUrl(latitude: number, longitude: number): string {
  return (
    `https://api.open-meteo.com/v1/forecast?latitude=${latitude.toFixed(2)}&longitude=${longitude.toFixed(2)}` +
    '&current=temperature_2m,weather_code&temperature_unit=celsius'
  );
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function parseCurrent(body: unknown): CurrentWeather {
  const current = typeof body === 'object' && body !== null ? (body as { current?: unknown }).current : undefined;
  const c = typeof current === 'object' && current !== null ? (current as Record<string, unknown>) : {};
  const temperature = c.temperature_2m;
  const code = c.weather_code;
  if (
    typeof temperature !== 'number' ||
    !Number.isFinite(temperature) ||
    typeof code !== 'number' ||
    !Number.isInteger(code)
  ) {
    throw new OpenMeteoError('invalid response');
  }
  return { temperatureC: temperature, weatherCode: code };
}

/**
 * Fetch the current weather. Throws `OpenMeteoError` ("timeout after 10 s", "HTTP 500", "invalid response", "aborted"
 * when `signal` fires, or the message of a network error).
 */
export async function fetchCurrentWeather(
  fetch: FetchLike,
  latitude: number,
  longitude: number,
  timeoutMs: number = OPEN_METEO_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<CurrentWeather> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new OpenMeteoError(`timeout after ${timeoutMs / 1000} s`));
    }, timeoutMs);
    onAbort = () => {
      controller.abort();
      reject(new OpenMeteoError('aborted'));
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
  const request = (async (): Promise<CurrentWeather> => {
    let response;
    let body: unknown;
    try {
      response = await fetch(openMeteoUrl(latitude, longitude), { signal: controller.signal });
      if (!response.ok) throw new OpenMeteoError(`HTTP ${response.status}`);
      body = await response.json();
    } catch (e) {
      throw e instanceof OpenMeteoError ? e : new OpenMeteoError(messageOf(e));
    }
    return parseCurrent(body);
  })();
  try {
    return await Promise.race([request, guard]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

export interface WeatherUpdaterOptions {
  fetch: FetchLike;
  /** Homey's location; may throw. */
  location: () => { latitude: number; longitude: number };
  /** Receives every new weather value (the controller stores and sends it). */
  onWeather: (weather: Weather) => Promise<void>;
  log: (message: string) => void;
}

/** A usable location: finite, in range and not exactly 0,0 (what an unset location reads as). */
function validLocation(l: { latitude: number; longitude: number }): boolean {
  const { latitude, longitude } = l;
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180 &&
    !(latitude === 0 && longitude === 0)
  );
}

/**
 * Fetches the weather at Homey's location from Open-Meteo: at once when enabled, then every interval, after a failure
 * again after `min(interval, 5 min)`. `configure` (re)starts the schedule, `stop` ends it for good: the timer is
 * cleared, a running request is aborted, late results are ignored and nothing is called afterwards.
 */
export class WeatherUpdater {
  private generation = 0;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private abort: AbortController | undefined;
  private auto = false;
  private intervalMin = 30;

  constructor(private readonly options: WeatherUpdaterOptions) {}

  configure(config: { auto: boolean; intervalMin: number }): void {
    if (this.stopped) return;
    const wasOn = this.auto;
    this.cancel();
    this.auto = config.auto;
    this.intervalMin = config.intervalMin;
    if (!config.auto) {
      if (wasOn) this.options.log('[weather] automatic weather off');
      return;
    }
    this.options.log(`[weather] automatic weather on (every ${config.intervalMin} min)`);
    void this.update(this.generation);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.auto = false;
    this.cancel();
  }

  /** Invalidate everything that is scheduled or in flight. */
  private cancel(): void {
    this.generation++;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.abort?.abort();
    this.abort = undefined;
  }

  private schedule(generation: number, delayMs: number): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.update(generation);
    }, delayMs);
  }

  private async update(generation: number): Promise<void> {
    const { log } = this.options;
    const intervalMs = this.intervalMin * 60_000;
    const failed = (message: string): void => {
      const retryMs = Math.min(intervalMs, OPEN_METEO_RETRY_MS);
      log(`[weather] open-meteo failed: ${message}; retry in ${retryMs / 60_000} min`);
      this.schedule(generation, retryMs);
    };

    let location: { latitude: number; longitude: number } | undefined;
    try {
      const l = this.options.location();
      if (validLocation(l)) location = l;
    } catch {
      // treated like a missing location
    }
    if (!location) {
      log('[weather] open-meteo: Homey has no location');
      this.schedule(generation, intervalMs);
      return;
    }

    const controller = new AbortController();
    this.abort = controller;
    let current: CurrentWeather;
    try {
      current = await fetchCurrentWeather(
        this.options.fetch,
        location.latitude,
        location.longitude,
        OPEN_METEO_TIMEOUT_MS,
        controller.signal,
      );
    } catch (e) {
      if (generation !== this.generation) return;
      this.abort = undefined;
      failed(messageOf(e));
      return;
    }
    if (generation !== this.generation) return;
    this.abort = undefined;

    const condition = wmoToCondition(current.weatherCode);
    if (condition === null) {
      log(`[weather] open-meteo: unknown weather code ${current.weatherCode}, not sent`);
      this.schedule(generation, intervalMs);
      return;
    }
    const temperatureC = clampTemperature(current.temperatureC, (rounded, clamped) =>
      log(`[weather] open-meteo: temperature ${rounded} °C out of range, clamped to ${clamped} °C`),
    );
    log(
      `[weather] open-meteo: ${temperatureC} °C (raw ${current.temperatureC}), code ${current.weatherCode} -> ${condition}`,
    );
    try {
      await this.options.onWeather({ temperatureC, condition });
    } catch (e) {
      if (generation !== this.generation) return;
      failed(messageOf(e));
      return;
    }
    if (generation !== this.generation) return;
    this.schedule(generation, intervalMs);
  }
}
