import { describe, expect, it } from 'vitest';
import { resolveUseAsLight, targetDeviceClass, USE_AS_LIGHT_SETTING } from './lightClass';

describe('light device class (#19)', () => {
  it('uses the setting id of the manifest', () => {
    expect(USE_AS_LIGHT_SETTING).toBe('use_as_light');
  });

  it('is on only for the boolean true', () => {
    expect(resolveUseAsLight(true)).toBe(true);
    expect(resolveUseAsLight(false)).toBe(false);
    expect(resolveUseAsLight(undefined)).toBe(false);
    expect(resolveUseAsLight(null)).toBe(false);
    expect(resolveUseAsLight('true')).toBe(false);
    expect(resolveUseAsLight(1)).toBe(false);
  });

  it('maps the option to the device class', () => {
    expect(targetDeviceClass(true)).toBe('light');
    expect(targetDeviceClass(false)).toBe('other');
  });
});
