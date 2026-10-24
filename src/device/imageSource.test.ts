import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { translator } from './__fixtures__/translator';
import { localiseError } from './argumentError';
import { ImageError } from './image';
import {
  downloadImage,
  loadImageToken,
  parseImageUrl,
  readImageStream,
  urlForLog,
  type ImageFetchLike,
  type ImageResponse,
  type ImageStreamLike,
} from './imageSource';

/** A response whose body delivers `chunks`; `read` records the cancel call. */
function response(chunks: Uint8Array[], init: { ok?: boolean; status?: number; length?: string | null } = {}) {
  const cancel = vi.fn(() => Promise.resolve());
  let i = 0;
  const res: ImageResponse = {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    headers: { get: (name) => (name.toLowerCase() === 'content-length' ? (init.length ?? null) : null) },
    body: {
      getReader: () => ({
        read: () => Promise.resolve(i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }),
        cancel,
      }),
    },
  };
  return { res, cancel };
}

const bytes = (n: number, fill = 1) => new Uint8Array(n).fill(fill);

describe('parseImageUrl', () => {
  it('accepts http and https and normalises', () => {
    expect(parseImageUrl('https://example.com/a.png')).toBe('https://example.com/a.png');
    expect(parseImageUrl('  http://192.168.1.5:8080/cam?x=1 ')).toBe('http://192.168.1.5:8080/cam?x=1');
    expect(parseImageUrl('HTTPS://Example.COM')).toBe('https://example.com/');
  });

  it.each([
    ['ftp', 'ftp://example.com/a.png'],
    ['file', 'file:///etc/passwd'],
    ['data', 'data:image/png;base64,AAAA'],
    ['no scheme', 'example.com/a.png'],
    ['empty', ''],
    ['blank', '   '],
    ['credentials', 'https://user:pw@example.com/a.png'],
    ['user only', 'https://user@example.com/a.png'],
    ['no host', 'https://'],
    ['too long', `https://example.com/${'a'.repeat(2048)}`],
    ['number', 42],
    ['null', null],
    ['undefined', undefined],
    ['object', {}],
  ])('rejects %s as invalid_url', (_name, value) => {
    expect(() => parseImageUrl(value)).toThrow(RangeError);
    try {
      parseImageUrl(value);
    } catch (e) {
      expect(e).toMatchObject({ kind: 'invalid_url', field: 'url' });
    }
  });

  it('accepts exactly 2048 characters', () => {
    const url = `https://example.com/${'a'.repeat(2048 - 'https://example.com/'.length)}`;
    expect(url).toHaveLength(2048);
    expect(parseImageUrl(url)).toBe(url);
  });

  it('gives a localised message', () => {
    try {
      parseImageUrl('ftp://x/a.png');
    } catch (e) {
      expect((localiseError(e, translator('en')) as Error).message).toContain(
        'URL: "ftp://x/a.png" is not a web address',
      );
      expect((localiseError(e, translator('de')) as Error).message).toContain(
        'URL: "ftp://x/a.png" ist keine Webadresse',
      );
      expect((localiseError(e, translator('en')) as Error).message).toContain('2048');
    }
  });
});

describe('urlForLog', () => {
  it('keeps only the host and port', () => {
    expect(urlForLog('https://user:secret@example.com:8443/private/path.png?token=abc#frag')).toBe('example.com:8443');
    expect(urlForLog('http://192.168.1.5/cam.jpg?key=1')).toBe('192.168.1.5');
  });

  it('never returns path or query for an invalid url', () => {
    expect(urlForLog('not a url /secret?x=1')).toBe('(invalid url)');
  });
});

describe('downloadImage', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns the concatenated body', async () => {
    const { res } = response([Uint8Array.of(1, 2), Uint8Array.of(3)]);
    const fetch = vi.fn<ImageFetchLike>(() => Promise.resolve(res));
    await expect(downloadImage(fetch, 'https://example.com/a.png')).resolves.toEqual(Uint8Array.of(1, 2, 3));
    expect(fetch.mock.calls[0][0]).toBe('https://example.com/a.png');
  });

  it('reports an HTTP error as unreachable', async () => {
    const { res } = response([], { ok: false, status: 404 });
    const error = await downloadImage(() => Promise.resolve(res), 'https://example.com/a.png').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImageError);
    expect(error).toMatchObject({ kind: 'unreachable', message: 'HTTP 404' });
  });

  it('reports a network error as unreachable', async () => {
    const error = await downloadImage(() => Promise.reject(new TypeError('fetch failed')), 'https://x/a').catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ kind: 'unreachable' });
    expect((error as Error).message).toContain('fetch failed');
  });

  it('keeps the system error code of the cause in the log message', async () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND example.invalid'), { code: 'ENOTFOUND' });
    const fetch: ImageFetchLike = () => Promise.reject(new TypeError('fetch failed', { cause }));
    const error = await downloadImage(fetch, 'https://example.invalid/a').catch((e: unknown) => e);
    expect((error as Error).message).toBe('request failed: fetch failed (ENOTFOUND)');
  });

  it('gives up after the timeout and aborts the request', async () => {
    let signal: AbortSignal | undefined;
    const fetch: ImageFetchLike = (_url, init) => {
      signal = init.signal;
      return new Promise(() => undefined);
    };
    const result = downloadImage(fetch, 'https://x/a', { timeoutMs: 10_000 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    const error = await result;
    expect(error).toMatchObject({ kind: 'unreachable', message: 'timeout after 10 s' });
    expect(signal?.aborted).toBe(true);
  });

  it('times out a body that stalls', async () => {
    const res = response([]).res;
    res.body = { getReader: () => ({ read: () => new Promise(() => undefined), cancel: () => Promise.resolve() }) };
    const result = downloadImage(() => Promise.resolve(res), 'https://x/a').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(result).resolves.toMatchObject({ kind: 'unreachable' });
  });

  it('refuses a declared size over the limit without reading', async () => {
    const { res, cancel } = response([bytes(10)], { length: '5242881' });
    const error = await downloadImage(() => Promise.resolve(res), 'https://x/a').catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'too_large', params: { max_mb: 5, max_mp: 8.3, max_side: 16384 } });
    expect(cancel).toHaveBeenCalled();
  });

  it('accepts a declared size exactly at the limit', async () => {
    const { res } = response([bytes(8)], { length: '8' });
    await expect(downloadImage(() => Promise.resolve(res), 'https://x/a', { maxBytes: 8 })).resolves.toHaveLength(8);
  });

  it('cancels the download once the streamed size passes the limit', async () => {
    const { res, cancel } = response([bytes(6), bytes(6), bytes(6)]);
    const error = await downloadImage(() => Promise.resolve(res), 'https://x/a', { maxBytes: 10 }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ kind: 'too_large' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('reports a body read error as unreachable', async () => {
    const res = response([]).res;
    res.body = {
      getReader: () => ({ read: () => Promise.reject(new Error('socket hang up')), cancel: () => Promise.resolve() }),
    };
    await expect(downloadImage(() => Promise.resolve(res), 'https://x/a')).rejects.toMatchObject({
      kind: 'unreachable',
    });
  });

  it('reports a missing body as unreachable', async () => {
    const res = response([]).res;
    res.body = null;
    await expect(downloadImage(() => Promise.resolve(res), 'https://x/a')).rejects.toMatchObject({
      kind: 'unreachable',
    });
  });

  it('does not put the url into an error message it throws for a failed request', async () => {
    const { res } = response([], { ok: false, status: 500 });
    const error = (await downloadImage(() => Promise.resolve(res), 'https://x/secret?token=1').catch(
      (e: unknown) => e,
    )) as Error;
    expect(error.message).not.toContain('secret');
  });
});

describe('readImageStream', () => {
  const stream = (
    parts: Array<Uint8Array | string | Error>,
  ): ImageStreamLike & { destroy: ReturnType<typeof vi.fn> } => ({
    async *[Symbol.asyncIterator]() {
      for (const part of parts) {
        if (part instanceof Error) throw part;
        yield part;
      }
    },
    destroy: vi.fn(),
  });

  it('reads the whole stream', async () => {
    await expect(readImageStream(stream([Uint8Array.of(1, 2), Uint8Array.of(3)]))).resolves.toEqual(
      Uint8Array.of(1, 2, 3),
    );
  });

  it('accepts a stream exactly at the limit and destroys one over it', async () => {
    await expect(readImageStream(stream([bytes(10)]), { maxBytes: 10 })).resolves.toHaveLength(10);
    const s = stream([bytes(6), bytes(6)]);
    await expect(readImageStream(s, { maxBytes: 10 })).rejects.toMatchObject({ kind: 'too_large' });
    expect(s.destroy).toHaveBeenCalled();
  });

  it('reports a stream error as unreadable', async () => {
    await expect(readImageStream(stream([bytes(2), new Error('boom')]))).rejects.toMatchObject({
      kind: 'unreadable',
      message: 'stream failed: boom',
    });
  });

  it('gives up on a stalled stream', async () => {
    vi.useFakeTimers();
    try {
      const s: ImageStreamLike & { destroy: ReturnType<typeof vi.fn> } = {
        [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }),
        destroy: vi.fn(),
      };
      const result = readImageStream(s, { timeoutMs: 5_000 }).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(result).resolves.toMatchObject({ kind: 'unreadable', message: 'timeout after 5 s' });
      expect(s.destroy).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('loadImageToken', () => {
  const token = (parts: Array<Uint8Array | Error>) => ({
    getStream: async () => ({
      async *[Symbol.asyncIterator]() {
        for (const part of parts) {
          if (part instanceof Error) throw part;
          yield part;
        }
      },
      destroy: vi.fn(),
    }),
  });

  it('reads the stream of the token', async () => {
    await expect(loadImageToken(token([Uint8Array.of(1), Uint8Array.of(2, 3)]))).resolves.toEqual(
      Uint8Array.of(1, 2, 3),
    );
  });

  it.each([undefined, null, {}, 'image', 42, { getStream: 'x' }])('reports %j as missing', async (value) => {
    await expect(loadImageToken(value)).rejects.toMatchObject({ kind: 'missing' });
  });

  it('reports a failing getStream as unreadable', async () => {
    const failing = {
      getStream: async () => {
        throw new Error('gone');
      },
    };
    await expect(loadImageToken(failing)).rejects.toMatchObject({ kind: 'unreadable' });
  });

  it('applies the size limit', async () => {
    await expect(loadImageToken(token([bytes(6), bytes(6)]), { maxBytes: 10 })).rejects.toMatchObject({
      kind: 'too_large',
    });
  });

  it('gives up on a getStream that never settles (one deadline for opening and reading)', async () => {
    vi.useFakeTimers();
    try {
      const hanging = { getStream: () => new Promise(() => undefined) };
      const result = loadImageToken(hanging).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(9_999);
      let settled = false;
      void result.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toMatchObject({ kind: 'unreadable', message: 'timeout after 10 s' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('destroys a stream that is opened after the deadline', async () => {
    vi.useFakeTimers();
    try {
      const destroy = vi.fn();
      let open: (s: ImageStreamLike) => void = () => undefined;
      const late = { getStream: () => new Promise<ImageStreamLike>((resolve) => (open = resolve)) };
      const result = loadImageToken(late, { timeoutMs: 2_000 }).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(result).resolves.toMatchObject({ kind: 'unreadable' });
      open({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }), destroy });
      await vi.advanceTimersByTimeAsync(0);
      expect(destroy).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
