import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Structure of .homeychangelog.json (#37). Its match with the app version is checked by `npm run release:check` (#38).
const changelog = JSON.parse(readFileSync(join(__dirname, '..', '.homeychangelog.json'), 'utf8')) as Record<
  string,
  Record<string, unknown>
>;
const versions = Object.keys(changelog);
const parts = (version: string): number[] => version.split('.').map(Number);

describe('.homeychangelog.json (#37)', () => {
  it('has only X.Y.Z keys', () => {
    expect(versions.length).toBeGreaterThan(0);
    for (const version of versions) expect(version).toMatch(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  });

  it('lists the versions in ascending order without duplicates', () => {
    for (let i = 1; i < versions.length; i++) {
      const [a, b] = [parts(versions[i - 1]), parts(versions[i])];
      const ascending = a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] < b[2];
      expect(ascending, `${versions[i - 1]} before ${versions[i]}`).toBe(true);
    }
  });

  it('has a non-empty English and German text for every entry', () => {
    for (const version of versions) {
      for (const locale of ['en', 'de']) {
        const text = changelog[version][locale];
        expect(typeof text === 'string' && text.trim() !== '', `${version} ${locale}`).toBe(true);
      }
    }
  });

  it('covers every released version (0.3.0 was never released, #117)', () => {
    for (const version of ['0.2.0', '0.4.0', '0.5.0']) expect(versions).toContain(version);
  });
});
