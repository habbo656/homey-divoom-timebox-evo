import { readFileSync } from 'node:fs';

type Tree = { [key: string]: string | Tree };

/** A translator that reads the real locale file by dot path, as `homey.__` does; throws for a missing key. */
export function translator(language: 'en' | 'de'): (key: string) => string {
  const root = JSON.parse(readFileSync(`locales/${language}.json`, 'utf8')) as Tree;
  return (key) => {
    let node: string | Tree | undefined = root;
    for (const part of key.split('.')) node = typeof node === 'object' ? node[part] : undefined;
    if (typeof node !== 'string') throw new Error(`missing locale key ${key}`);
    return node;
  };
}
