import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchCurrentWeather,
  OPEN_METEO_RETRY_MS,
  OPEN_METEO_TIMEOUT_MS,
  openMeteoUrl,
  OpenMeteoError,
  WeatherUpdater,
  type FetchLike,
} from './openMeteo';
import type { Weather } from './weather';

const ok = (current: unknown): ReturnType<FetchLike> =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ current }) });

describe('openMeteoUrl', () => {
  it('rounds the coordinates to two decimals', () => {
    expect(openMeteoUrl(52.520008, 13.404954)).toBe(
      'https://api.open-meteo.com/v1/forecast?latitude=52.52&longitude=13.40&current=temperature_2m,weather_code&temperature_unit=celsius',
    );
    expect(openMeteoUrl(-33.8688, -151.2093)).toContain('latitude=-33.87&longitude=-151.21');
  });
});

describe('fetchCurrentWeather', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns the temperature and the weather code', async () => {
    const fetch = vi.fn<FetchLike>(() => ok({ temperature_2m: 21.4, weather_code: 3 }));
    await expect(fetchCurrentWeather(fetch, 52.5, 13.4)).resolves.toEqual({ temperatureC: 21.4, weatherCode: 3 });
    expect(fetch.mock.calls[0][0]).toBe(openMeteoUrl(52.5, 13.4));
  });

  it('throws on an HTTP error', async () => {
    const fetch: FetchLike = () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
    await expect(fetchCurrentWeather(fetch, 1, 1)).rejects.toThrow(new OpenMeteoError('HTTP 500'));
  });

  it.each([
    ['no current', undefined],
    ['null current', null],
    ['no temperature', { weather_code: 3 }],
    ['string temperature', { temperature_2m: '21', weather_code: 3 }],
    ['NaN temperature', { temperature_2m: NaN, weather_code: 3 }],
    ['no code', { temperature_2m: 21 }],
    ['fractional code', { temperature_2m: 21, weather_code: 3.5 }],
  ])('throws "invalid response" for %s', async (_name, current) => {
    await expect(fetchCurrentWeather(() => ok(current), 1, 1)).rejects.toThrow('invalid response');
  });

  it('throws "invalid response" when the body is not an object', async () => {
    const fetch: FetchLike = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve('x') });
    await expect(fetchCurrentWeather(fetch, 1, 1)).rejects.toThrow('invalid response');
  });

  it('throws the message of a network error', async () => {
    const fetch: FetchLike = () => Promise.reject(new TypeError('fetch failed'));
    const error = await fetchCurrentWeather(fetch, 1, 1).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpenMeteoError);
    expect((error as Error).message).toBe('fetch failed');
  });

  it('times out and aborts the request', async () => {
    let signal: AbortSignal | undefined;
    const fetch: FetchLike = (_url, init) => {
      signal = init.signal;
      return new Promise(() => undefined);
    };
    const result = fetchCurrentWeather(fetch, 1, 1).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(OPEN_METEO_TIMEOUT_MS);
    expect(((await result) as Error).message).toBe('timeout after 10 s');
    expect(signal?.aborted).toBe(true);
  });

  it('aborts on the external signal', async () => {
    const outer = new AbortController();
    const result = fetchCurrentWeather(() => new Promise(() => undefined), 1, 1, undefined, outer.signal).catch(
      (e: unknown) => e,
    );
    outer.abort();
    expect(((await result) as Error).message).toBe('aborted');
  });
});

describe('WeatherUpdater', () => {
  const MIN = 60_000;
  let logs: string[];
  let received: Weather[];
  let onWeather: ReturnType<typeof vi.fn<(w: Weather) => Promise<void>>>;
  let location: () => { latitude: number; longitude: number };
  let fetch: ReturnType<typeof vi.fn<FetchLike>>;

  const build = (): WeatherUpdater =>
    new WeatherUpdater({ fetch, location: () => location(), onWeather, log: (m) => logs.push(m) });

  beforeEach(() => {
    vi.useFakeTimers();
    logs = [];
    received = [];
    onWeather = vi.fn((w: Weather) => {
      received.push(w);
      return Promise.resolve();
    });
    location = () => ({ latitude: 52.5, longitude: 13.4 });
    fetch = vi.fn<FetchLike>(() => ok({ temperature_2m: 21.4, weather_code: 61 }));
  });
  afterEach(() => vi.useRealTimers());

  it('fetches at once when enabled, then every interval', async () => {
    const updater = build();
    updater.configure({ auto: true, intervalMin: 30 });
    await vi.advanceTimersByTimeAsync(0);
    expect(received).toEqual([{ temperatureC: 21, condition: 'rain' }]);
    expect(logs).toEqual([
      '[weather] automatic weather on (every 30 min)',
      '[weather] open-meteo: 21 °C (raw 21.4), code 61 -> rain',
    ]);
    await vi.advanceTimersByTimeAsync(29 * MIN);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(MIN);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(fetch).toHaveBeenCalledTimes(3);
    updater.stop();
  });

  it('does nothing while off and logs "off" only when it was on', async () => {
    const updater = build();
    updater.configure({ auto: false, intervalMin: 30 });
    await vi.advanceTimersByTimeAsync(2 * 60 * MIN);
    expect(fetch).not.toHaveBeenCalled();
    expect(logs).toEqual([]);
    updater.configure({ auto: true, intervalMin: 30 });
    updater.configure({ auto: false, intervalMin: 30 });
    expect(logs.at(-1)).toBe('[weather] automatic weather off');
    await vi.advanceTimersByTimeAsync(2 * 60 * MIN);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retries after a failure in min(interval, 5 min)', async () => {
    fetch.mockImplementationOnce(() => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) }));
    const updater = build();
    updater.configure({ auto: true, intervalMin: 30 });
    await vi.advanceTimersByTimeAsync(0);
    expect(logs.at(-1)).toBe('[weather] open-meteo failed: HTTP 500; retry in 5 min');
    expect(received).toEqual([]);
    await vi.advanceTimersByTimeAsync(OPEN_METEO_RETRY_MS - 1);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(received).toHaveLength(1);
    // back on the normal interval
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(fetch).toHaveBeenCalledTimes(3);
    updater.stop();
  });

  it('retries a rejected fetch and a bad response', async () => {
    fetch.mockImplementationOnce(() => Promise.reject(new TypeError('fetch failed')));
    fetch.mockImplementationOnce(() => ok({ temperature_2m: 'x' }));
    const updater = build();
    updater.configure({ auto: true, intervalMin: 15 });
    await vi.advanceTimersByTimeAsync(0);
    expect(logs.at(-1)).toBe('[weather] open-meteo failed: fetch failed; retry in 5 min');
    await vi.advanceTimersByTimeAsync(OPEN_METEO_RETRY_MS);
    expect(logs.at(-1)).toBe('[weather] open-meteo failed: invalid response; retry in 5 min');
    await vi.advanceTimersByTimeAsync(OPEN_METEO_RETRY_MS);
    expect(received).toHaveLength(1);
    updater.stop();
  });

  it('retries after a timeout', async () => {
    fetch.mockImplementationOnce(() => new Promise(() => undefined));
    const updater = build();
    updater.configure({ auto: true, intervalMin: 30 });
    await vi.advanceTimersByTimeAsync(OPEN_METEO_TIMEOUT_MS);
    expect(logs.at(-1)).toBe('[weather] open-meteo failed: timeout after 10 s; retry in 5 min');
    await vi.advanceTimersByTimeAsync(OPEN_METEO_RETRY_MS);
    expect(received).toHaveLength(1);
    updater.stop();
  });

  it('retries when the receiver fails', async () => {
    onWeather.mockRejectedValueOnce(new Error('boom'));
    const updater = build();
    updater.configure({ auto: true, intervalMin: 30 });
    await vi.advanceTimersByTimeAsync(0);
    expect(logs.at(-1)).toBe('[weather] open-meteo failed: boom; retry in 5 min');
    await vi.advanceTimersByTimeAsync(OPEN_METEO_RETRY_MS);
    expect(onWeather).toHaveBeenCalledTimes(2);
    updater.stop();
  });

  describe('switched off or stopped during a request', () => {
    const slow = (): { resolve: () => void; signals: AbortSignal[] } => {
      const signals: AbortSignal[] = [];
      let resolve = (): void => undefined;
      fetch.mockImplementationOnce((_url, init) => {
        signals.push(init.signal);
        return new Promise((res) => {
          resolve = () =>
            res({
              ok: true,
              status: 200,
              json: () => Promise.resolve({ current: { temperature_2m: 5, weather_code: 0 } }),
            });
        });
      });
      return { resolve: () => resolve(), signals };
    };

    it('ignores the late result when switched off', async () => {
      const pending = slow();
      const updater = build();
      updater.configure({ auto: true, intervalMin: 30 });
      await vi.advanceTimersByTimeAsync(0);
      updater.configure({ auto: false, intervalMin: 30 });
      expect(pending.signals[0].aborted).toBe(true);
      pending.resolve();
      await vi.advanceTimersByTimeAsync(2 * 60 * MIN);
      expect(onWeather).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('ignores the late result after stop, which is idempotent', async () => {
      const pending = slow();
      const updater = build();
      updater.configure({ auto: true, intervalMin: 30 });
      await vi.advanceTimersByTimeAsync(0);
      updater.stop();
      updater.stop();
      expect(pending.signals[0].aborted).toBe(true);
      pending.resolve();
      updater.configure({ auto: true, intervalMin: 15 });
      const logCount = logs.length;
      await vi.advanceTimersByTimeAsync(2 * 60 * MIN);
      expect(onWeather).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(logs).toHaveLength(logCount);
    });

    it('clears the timer on stop', async () => {
      const updater = build();
      updater.configure({ auto: true, intervalMin: 30 });
      await vi.advanceTimersByTimeAsync(0);
      updater.stop();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it('reconfigure reschedules with the new interval and fetches at once', async () => {
    const updater = build();
    updater.configure({ auto: true, intervalMin: 60 });
    await vi.advanceTimersByTimeAsync(0);
    updater.configure({ auto: true, intervalMin: 15 });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(logs).toContain('[weather] automatic weather on (every 15 min)');
    await vi.advanceTimersByTimeAsync(15 * MIN);
    expect(fetch).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(15 * MIN);
    expect(fetch).toHaveBeenCalledTimes(4);
    updater.stop();
  });

  it.each([
    ['not finite', { latitude: NaN, longitude: 13 }],
    ['latitude out of range', { latitude: 91, longitude: 13 }],
    ['longitude out of range', { latitude: 52, longitude: -181 }],
    ['exactly 0,0', { latitude: 0, longitude: 0 }],
  ])('does not fetch without a location (%s) and retries next interval', async (_name, value) => {
    location = () => value;
    const updater = build();
    updater.configure({ auto: true, intervalMin: 30 });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(logs.at(-1)).toBe('[weather] open-meteo: Homey has no location');
    location = () => ({ latitude: 52.5, longitude: 13.4 });
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(received).toHaveLength(1);
    updater.stop();
  });

  it('treats a throwing location getter as no location', async () => {
    location = () => {
      throw new Error('no geolocation');
    };
    const updater = build();
    updater.configure({ auto: true, intervalMin: 30 });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(logs.at(-1)).toBe('[weather] open-meteo: Homey has no location');
    updater.stop();
  });

  it('does not send an unknown weather code', async () => {
    fetch.mockImplementationOnce(() => ok({ temperature_2m: 10, weather_code: 58 }));
    const updater = build();
    updater.configure({ auto: true, intervalMin: 30 });
    await vi.advanceTimersByTimeAsync(0);
    expect(onWeather).not.toHaveBeenCalled();
    expect(logs.at(-1)).toBe('[weather] open-meteo: unknown weather code 58, not sent');
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(received).toHaveLength(1);
    updater.stop();
  });

  it('rounds and clamps the temperature and logs the clamp', async () => {
    fetch.mockImplementationOnce(() => ok({ temperature_2m: 120.4, weather_code: 0 }));
    fetch.mockImplementationOnce(() => ok({ temperature_2m: -0.4, weather_code: 71 }));
    const updater = build();
    updater.configure({ auto: true, intervalMin: 15 });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(15 * MIN);
    expect(received).toEqual([
      { temperatureC: 99, condition: 'clear' },
      { temperatureC: 0, condition: 'snow' },
    ]);
    expect(Object.is(received[1].temperatureC, -0)).toBe(false);
    expect(logs).toContain('[weather] open-meteo: temperature 120 °C out of range, clamped to 99 °C');
    updater.stop();
  });

  it('never logs coordinates', async () => {
    const updater = build();
    updater.configure({ auto: true, intervalMin: 30 });
    await vi.advanceTimersByTimeAsync(0);
    expect(logs.join('\n')).not.toMatch(/52\.5|13\.4|latitude|longitude/);
    updater.stop();
  });
});
