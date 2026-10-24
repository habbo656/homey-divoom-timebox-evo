import { describe, expect, it } from 'vitest';
import { fillPlaceholders } from './text';

describe('fillPlaceholders', () => {
  it('fills every occurrence, numbers included', () => {
    expect(fillPlaceholders('{min} to {max}, at least {min}', { min: 30, max: 3600 })).toBe('30 to 3600, at least 30');
  });

  it('leaves unknown tokens and text without tokens untouched', () => {
    expect(fillPlaceholders('{a} and {b}', { a: 'x' })).toBe('x and {b}');
    expect(fillPlaceholders('plain', { a: 1 })).toBe('plain');
    expect(fillPlaceholders('{toString}', {})).toBe('{toString}');
  });

  it('does not interpret replacement patterns', () => {
    expect(fillPlaceholders('{a}', { a: '$& $1' })).toBe('$& $1');
  });
});
