import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ignore from 'ignore';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';

// Store listing assets and texts (#92): icons, images, name, description and the per-locale store readme.
const root = join(__dirname, '..');
const read = (...parts: string[]): string => readFileSync(join(root, ...parts), 'utf8');
const readPng = (...parts: string[]): PNG => PNG.sync.read(readFileSync(join(root, ...parts)));

const DESCRIPTION = { en: 'The pixel heart of your smart home.', de: 'Das Pixel-Herz deines Smart Homes.' };
const NAME = { en: 'Divoom TimeBox Evo', de: 'Divoom TimeBox Evo' }; // owner, 2026-10-18

interface AppManifest {
  id: string;
  name: Record<string, string>;
  description: Record<string, string>;
  icon?: string;
  drivers?: { icon?: string }[];
}
const readManifest = (...parts: string[]): AppManifest => JSON.parse(read(...parts)) as AppManifest;

describe('SVG icons (#92, #147)', () => {
  const icons = { app: read('assets', 'icon.svg'), driver: read('drivers', 'timebox', 'assets', 'icon.svg') };

  for (const [name, svg] of Object.entries(icons)) {
    it(`${name} icon is a monochrome 960x960 vector`, () => {
      expect(svg).toContain('viewBox="0 0 960 960"');
      for (const forbidden of ['<image', 'Gradient', '<text', 'style=', '<rect']) {
        expect(svg).not.toContain(forbidden);
      }
      const colours = [...svg.matchAll(/\b(?:fill|stroke)="([^"]*)"/g)].map((m) => m[1]);
      expect(colours.length).toBeGreaterThan(0);
      for (const colour of colours) expect(['#000000', '#000', 'black', 'none']).toContain(colour);
    });
  }

  // Defensive path-data form (#147, unconfirmed): the app icon was not shown in "Add new device" / the store although it renders
  // in browsers. The cause is unknown (many working Athom icons use implicit repeats and evenodd), so the app icon is redrawn in
  // the canonical form of the working driver icon: every segment has its own command letter, no implicit lineto pairs, no fill rule.
  // Space separators and plain decimals only (no commas, no exponents).
  const ARGS: Record<string, number> = { M: 2, L: 2, T: 2, H: 1, V: 1, Z: 0, A: 7, C: 6, Q: 4, S: 4 };
  const NUMBER = /[-+]?(?:\d+\.?\d*|\.\d+)/g;
  const pathData = (svg: string): string[] => [...svg.matchAll(/<path\b[^>]*?\sd="([^"]*)"/g)].map((m) => m[1]);
  const segments = (d: string): { cmd: string; args: number[] }[] =>
    [...d.matchAll(/([A-Za-z])([^A-Za-z]*)/g)].map((m) => ({
      cmd: m[1],
      args: (m[2].match(NUMBER) ?? []).map(Number),
    }));

  for (const [name, svg] of Object.entries(icons)) {
    it(`${name} icon path data has one command letter per segment (#147)`, () => {
      const data = pathData(svg);
      expect(data.length).toBeGreaterThan(0);
      for (const d of data) {
        expect(d.replace(/[A-Za-z0-9\s.+-]/g, '')).toBe('');
        const segs = segments(d);
        expect(segs.length).toBeGreaterThan(0);
        for (const { cmd, args } of segs) {
          expect(ARGS[cmd.toUpperCase()], `${name}: command ${cmd}`).toBeDefined();
          // A longer list would be an implicit repeat (for example "M x y x y" or "H a b").
          expect(args.length, `${name}: ${cmd} ${args.join(' ')}`).toBe(ARGS[cmd.toUpperCase()]);
        }
      }
    });
  }

  it('the app icon uses no fill rule and only absolute M H V L Z commands (#147)', () => {
    expect(icons.app).not.toMatch(/fill-rule|clip-rule|evenodd/);
    for (const d of pathData(icons.app)) {
      for (const { cmd } of segments(d)) expect('MHVLZ').toContain(cmd);
    }
  });

  it('every app icon path is filled #000000 (#147)', () => {
    const paths = [...icons.app.matchAll(/<path\b[^>]*>/g)].map((m) => m[0]);
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) expect(path).toContain('fill="#000000"');
  });

  it('the app icon is the documented pixel fox when rasterised with nonzero winding (#147)', () => {
    // Copy of the grid in docs/architecture/store-assets.md: 16 x 16 cells of 60 px, '#' is filled.
    // Assumes the canonical form enforced by (a)/(b); it fails on the old file because implicit pairs are not parsed.
    const FOX_GRID = [
      '................',
      '................',
      '....#......#....',
      '...#.#....#.#...',
      '...#.##..##.#...',
      '...#.######.#...',
      '...##.####.##...',
      '...##########...',
      '...#.##..##.#...',
      '...#.#.##.#.#...',
      '..##.#.##.#.##..',
      '..##..#..#..##..',
      '.####......####.',
      '...##########...',
      '................',
      '................',
    ];
    type Point = [number, number];
    const loops: Point[][] = [];
    for (const d of pathData(icons.app)) {
      let loop: Point[] = [];
      let [x, y] = [0, 0];
      const close = (): void => {
        if (loop.length > 0) loops.push(loop);
        loop = [];
      };
      for (const { cmd, args } of segments(d)) {
        if (cmd === 'M') close();
        if (cmd === 'M' || cmd === 'L') [x, y] = [args[0], args[1]];
        if (cmd === 'H') x = args[0];
        if (cmd === 'V') y = args[0];
        if (cmd !== 'Z') loop.push([x, y]);
        else close();
      }
      close();
    }
    // Winding number of a point (crossing rule, edges never touch the cell centres).
    const winding = (px: number, py: number): number => {
      let w = 0;
      for (const loop of loops) {
        for (let i = 0; i < loop.length; i++) {
          const [x0, y0] = loop[i];
          const [x1, y1] = loop[(i + 1) % loop.length];
          if (y0 <= py && y1 > py && (x1 - x0) * (py - y0) - (px - x0) * (y1 - y0) > 0) w++;
          else if (y0 > py && y1 <= py && (x1 - x0) * (py - y0) - (px - x0) * (y1 - y0) < 0) w--;
        }
      }
      return w;
    };
    const raster = FOX_GRID.map((_, r) =>
      FOX_GRID[r]
        .split('')
        .map((__, c) => (winding(60 * c + 30, 60 * r + 30) !== 0 ? '#' : '.'))
        .join(''),
    );
    expect(raster).toEqual(FOX_GRID);
  });

  it('app and driver icon differ', () => {
    expect(icons.app).not.toBe(icons.driver);
  });

  it('the driver icon is stroke line art with the weights 40 / 20 / 10 px (#142, guideline 1.6)', () => {
    expect(icons.driver).not.toContain('transform');
    expect(icons.driver).toContain('stroke-linejoin="round"');
    const widths = [...icons.driver.matchAll(/stroke-width="([^"]*)"/g)].map((m) => m[1]);
    for (const width of widths) expect(['40', '20', '10']).toContain(width);
    for (const width of ['40', '20', '10']) expect(widths).toContain(width);
    // A stroked path without its own stroke-width would inherit the default of 1 px.
    const paths = [...icons.driver.matchAll(/<path\b[^>]*>/g)].map((m) => m[0]);
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(path.includes('stroke="none"') || /stroke-width="(40|20|10)"/.test(path)).toBe(true);
    }
  });
});

describe('driver images (#92)', () => {
  const corners = (png: PNG): number[][] => {
    const { width, height } = png;
    const out: number[][] = [];
    for (const x0 of [0, width - 2]) {
      for (const y0 of [0, height - 2]) {
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const i = ((y0 + dy) * width + x0 + dx) * 4;
            out.push([png.data[i], png.data[i + 1], png.data[i + 2]]);
          }
        }
      }
    }
    return out;
  };

  for (const [file, size] of [
    ['small', 75],
    ['large', 500],
    ['xlarge', 1000],
  ] as const) {
    it(`${file}.png is ${size}x${size} with white corners`, () => {
      const png = readPng('drivers', 'timebox', 'assets', 'images', `${file}.png`);
      expect([png.width, png.height]).toEqual([size, size]);
      for (const rgb of corners(png)) for (const channel of rgb) expect(channel).toBeGreaterThanOrEqual(250);
    });
  }
});

describe('app images (#92)', () => {
  for (const [file, width, height] of [
    ['small', 250, 175],
    ['large', 500, 350],
    ['xlarge', 1000, 700],
  ] as const) {
    it(`${file}.png is ${width}x${height}`, () => {
      const png = readPng('assets', 'images', `${file}.png`);
      expect([png.width, png.height]).toEqual([width, height]);
    });
  }
});

describe('store listing texts (#92)', () => {
  it('names and describes the app in the compose source and the generated manifest', () => {
    for (const manifest of [readManifest('.homeycompose', 'app.json'), readManifest('app.json')]) {
      expect(manifest.id).toBe('com.habbo656.divoom-timebox');
      expect(manifest.name).toEqual(NAME);
      expect(manifest.description).toEqual(DESCRIPTION);
    }
  });

  it('declares the app and driver icons explicitly (owner, 2026-10-18)', () => {
    expect(readManifest('.homeycompose', 'app.json').icon).toBe('/assets/icon.svg');
    expect(readManifest('drivers', 'timebox', 'driver.compose.json').icon).toBe('{{driverAssetsPath}}/icon.svg');
    const app = readManifest('app.json');
    expect(app.icon).toBe('/assets/icon.svg');
    expect(app.drivers?.[0]?.icon).toBe('/drivers/timebox/assets/icon.svg');
  });

  it('localises the app name', () => {
    for (const locale of ['en', 'de']) {
      const strings = JSON.parse(read('locales', `${locale}.json`)) as { app: { name: string } };
      expect(strings.app.name).toBe(NAME[locale as 'en' | 'de']);
    }
  });

  for (const [file, locale] of [
    ['README.txt', 'en'],
    ['README.de.txt', 'de'],
  ] as const) {
    describe(file, () => {
      it('exists and is plain text of at most two paragraphs', () => {
        expect(existsSync(join(root, file))).toBe(true);
        const text = read(file).trim();
        const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim() !== '');
        expect(paragraphs.length).toBeGreaterThanOrEqual(1);
        expect(paragraphs.length).toBeLessThanOrEqual(2);
        expect(text.length).toBeGreaterThan(200);
        expect(text).not.toBe(DESCRIPTION[locale]);
        expect(text).not.toMatch(/https?:\/\/|www\./);
        expect(text).not.toMatch(/^#|\*\*|`|^- /m);
      });
    });
  }
});

describe('app assets folder (#37)', () => {
  it('holds only icon.svg and images/ (no unreferenced source files)', () => {
    expect(readdirSync(join(root, 'assets')).sort()).toEqual(['icon.svg', 'images']);
  });
});

describe('manifest links and brand colour (#37)', () => {
  const REPO = 'https://github.com/habbo656/homey-divoom-timebox-evo';
  interface LinkManifest {
    brandColor: string;
    source: string;
    support: string;
    bugs: { url: string };
    homeyCommunityTopicId?: number;
  }
  const readLinks = (...parts: string[]): LinkManifest => JSON.parse(read(...parts)) as LinkManifest;

  for (const [label, parts] of [
    ['compose source', ['.homeycompose', 'app.json']],
    ['generated manifest', ['app.json']],
  ] as const) {
    describe(label, () => {
      const manifest = readLinks(...parts);

      it('links the source, support and bug tracker', () => {
        expect(manifest.source).toBe(REPO);
        expect(manifest.support).toBe(`${REPO}/issues`);
        expect(manifest.bugs).toEqual({ url: `${REPO}/issues` });
      });

      it('has a hex brand colour', () => {
        expect(manifest.brandColor).toMatch(/^#[0-9A-F]{6}$/i);
      });

      it('has no community topic id or a positive integer', () => {
        const id = manifest.homeyCommunityTopicId;
        if (id !== undefined) {
          expect(Number.isInteger(id)).toBe(true);
          expect(id).toBeGreaterThan(0);
        }
      });
    });
  }
});

describe('app bundle contents (#37)', () => {
  // The CLI applies .homeyignore through ignore-walk (minimatch); the `ignore` package approximates it for these simple anchored patterns.
  const matcher = ignore().add(read('.homeyignore'));

  it('keeps the development files out of the bundle', () => {
    for (const path of [
      'docs/README.md',
      'docs/architecture.md',
      'scripts/gate.sh',
      'CLAUDE.md',
      'README.md',
      'eslint.config.mjs',
      '.github/workflows/ci.yml',
      '.claude/settings.json',
      '.hwtest/issue-92/note.txt',
      '.venv/bin/python',
    ]) {
      expect(matcher.ignores(path), path).toBe(true);
    }
  });

  it('keeps the runtime files in the bundle', () => {
    for (const path of [
      'README.txt',
      'README.de.txt',
      'app.json',
      'app.js',
      '.homeychangelog.json',
      'assets/icon.svg',
      'assets/images/large.png',
      'locales/en.json',
      'drivers/timebox/driver.compose.json',
      'drivers/timebox/pair/scan.html',
      'drivers/timebox/assets/icon.svg',
      'dev/devHarness.js',
      'drivers/x/docs/a.md',
      'src/scripts/a.js',
    ]) {
      expect(matcher.ignores(path), path).toBe(false);
    }
  });
});
