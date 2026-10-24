// Where an image comes from (docs/architecture/images.md, #31): a URL that is downloaded with size and time limits, or
// the stream of an image Flow token. Homey-free: `fetch` and the stream are injected. Only the host of a URL is ever
// logged (`urlForLog`), never path, query or user info.
import { ArgumentError, formatArgValue } from './argumentError';
import { IMAGE_LOAD_TIMEOUT_MS, IMAGE_MAX_BYTES, ImageError, tooLarge } from './image';

/** Longest URL accepted, in characters. */
export const IMAGE_URL_MAX_CHARS = 2048;

/** The part of a `fetch` response that is used (a global `fetch` fits). */
export interface ImageResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  body: {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>;
      cancel(reason?: unknown): Promise<void>;
    };
  } | null;
}

/** The part of `fetch` that is used. */
export type ImageFetchLike = (url: string, init: { signal: AbortSignal }) => Promise<ImageResponse>;

/** The stream of an image token (a Node `Readable` fits). */
export interface ImageStreamLike {
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array | string>;
  destroy?(error?: Error): unknown;
}

/**
 * Validate the URL of "Show image from URL" and return it normalised: text of 1..2048 characters, `http:` or `https:`,
 * a host, no user name or password. Throws `ArgumentError` (a `RangeError`).
 */
export function parseImageUrl(value: unknown): string {
  const fail = (): never => {
    throw new ArgumentError('url must be an http or https address', 'invalid_url', 'url', {
      value: formatArgValue(value),
      max: IMAGE_URL_MAX_CHARS,
    });
  };
  if (typeof value !== 'string') return fail();
  const text = value.trim();
  if (text.length < 1 || text.length > IMAGE_URL_MAX_CHARS) return fail();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return fail();
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname || url.username || url.password) {
    return fail();
  }
  return url.href;
}

/** What may go to the log: the host (and port) only. */
export function urlForLog(url: string): string {
  try {
    return new URL(url).host || '(no host)';
  } catch {
    return '(invalid url)';
  }
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The message of a failed `fetch` with the system error code of its cause (`ENOTFOUND`, `ECONNREFUSED`, ...) if there is one. */
function networkCause(e: unknown): string {
  const cause = e instanceof Error ? (e as { cause?: unknown }).cause : undefined;
  const code = typeof cause === 'object' && cause !== null ? (cause as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? `${messageOf(e)} (${code})` : messageOf(e);
}

const tooMany = (maxBytes: number): ImageError => tooLarge(`image is larger than ${maxBytes} bytes`);

const concat = (chunks: Uint8Array[], total: number): Uint8Array => {
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
};

/** A timer that rejects with `kind` after `timeoutMs` (and aborts `controller`); `clear` ends it. */
function deadline(
  timeoutMs: number,
  controller: AbortController,
  kind: 'unreachable' | 'unreadable',
): { guard: Promise<never>; clear: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ImageError(`timeout after ${timeoutMs / 1000} s`, kind));
    }, timeoutMs);
  });
  guard.catch(() => undefined); // never an unhandled rejection when the race is already over
  return { guard, clear: () => clearTimeout(timer) };
}

export interface DownloadOptions {
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * Download an image. The whole load (request and body) is given up after `timeoutMs`; a body over `maxBytes` is
 * refused from the `content-length` header or while streaming (the download is cancelled). Throws `ImageError`:
 * `unreachable` (network error, HTTP error, timeout) or `too_large`.
 */
export async function downloadImage(
  fetch: ImageFetchLike,
  url: string,
  options: DownloadOptions = {},
): Promise<Uint8Array> {
  const timeoutMs = options.timeoutMs ?? IMAGE_LOAD_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? IMAGE_MAX_BYTES;
  const controller = new AbortController();
  const { guard, clear } = deadline(timeoutMs, controller, 'unreachable');
  const load = (async (): Promise<Uint8Array> => {
    let response: ImageResponse;
    try {
      response = await fetch(url, { signal: controller.signal });
    } catch (e) {
      throw new ImageError(`request failed: ${networkCause(e)}`, 'unreachable');
    }
    if (!response.ok) throw new ImageError(`HTTP ${response.status}`, 'unreachable');
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body
        ?.getReader()
        .cancel()
        .catch(() => undefined);
      throw tooMany(maxBytes);
    }
    if (!response.body) throw new ImageError('response has no body', 'unreachable');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.length;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw tooMany(maxBytes);
        }
        chunks.push(value);
      }
    } catch (e) {
      if (e instanceof ImageError) throw e;
      throw new ImageError(`download failed: ${messageOf(e)}`, 'unreachable');
    }
    return concat(chunks, total);
  })();
  load.catch(() => undefined);
  try {
    return await Promise.race([load, guard]);
  } finally {
    clear();
  }
}

/** Read `stream` to the end; over `maxBytes` it is destroyed (`too_large`), a stream error gives `unreadable`. */
async function readBody(stream: ImageStreamLike, maxBytes: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const part of stream) {
      const chunk = typeof part === 'string' ? new TextEncoder().encode(part) : part;
      total += chunk.length;
      if (total > maxBytes) {
        stream.destroy?.();
        throw tooMany(maxBytes);
      }
      chunks.push(chunk);
    }
  } catch (e) {
    if (e instanceof ImageError) throw e;
    throw new ImageError(`stream failed: ${messageOf(e)}`, 'unreadable');
  }
  return concat(chunks, total);
}

/** Run `load` against the deadline: after `timeoutMs` it is given up with `unreadable` and `onAbort` runs. */
async function withDeadline<T>(timeoutMs: number, onAbort: () => void, load: () => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const { guard, clear } = deadline(timeoutMs, controller, 'unreadable');
  controller.signal.addEventListener('abort', onAbort, { once: true });
  const run = load();
  run.catch(() => undefined);
  try {
    return await Promise.race([run, guard]);
  } finally {
    clear();
  }
}

/**
 * Read the stream of an image token completely. Over `maxBytes` the stream is destroyed (`too_large`); a stream
 * error or a stream that stalls longer than `timeoutMs` in total gives `unreadable`.
 */
export async function readImageStream(stream: ImageStreamLike, options: DownloadOptions = {}): Promise<Uint8Array> {
  const maxBytes = options.maxBytes ?? IMAGE_MAX_BYTES;
  return withDeadline(
    options.timeoutMs ?? IMAGE_LOAD_TIMEOUT_MS,
    () => stream.destroy?.(),
    () => readBody(stream, maxBytes),
  );
}

/**
 * Read the image of a Flow image token (Homey passes it as the `droptoken` argument; it has `getStream()`). Opening the
 * stream and reading it share one deadline (`timeoutMs`), so a `getStream()` that never settles cannot hold the image
 * queue. Throws `ImageError`: `missing` when the argument holds no image, else like `readImageStream`.
 */
export async function loadImageToken(token: unknown, options: DownloadOptions = {}): Promise<Uint8Array> {
  const getStream = (token as { getStream?: unknown } | null | undefined)?.getStream;
  if (typeof getStream !== 'function') throw new ImageError('no image token was given', 'missing');
  const maxBytes = options.maxBytes ?? IMAGE_MAX_BYTES;
  let stream: ImageStreamLike | undefined;
  let timedOut = false;
  return withDeadline(
    options.timeoutMs ?? IMAGE_LOAD_TIMEOUT_MS,
    () => {
      timedOut = true;
      stream?.destroy?.();
    },
    async () => {
      try {
        stream = (await (getStream as () => Promise<ImageStreamLike>).call(token)) as ImageStreamLike;
      } catch (e) {
        throw new ImageError(`image token could not be opened: ${messageOf(e)}`, 'unreadable');
      }
      if (timedOut) {
        stream.destroy?.(); // opened after the deadline: nobody reads it
        throw new ImageError('image token opened after the deadline', 'unreadable');
      }
      return readBody(stream, maxBytes);
    },
  );
}
