// Device class model (docs/architecture/power-lighting.md, "Use as a light"): the opt-in setting that makes Homey treat
// the TimeBox as a light (moods, "all lights off", voice commands). Pure, no Homey.

/** Id of the "Use as a light" device setting (`drivers/timebox/driver.settings.compose.json`). */
export const USE_AS_LIGHT_SETTING = 'use_as_light';

/** The two device classes the app switches between; the manifest class is `other`. */
export type TimeboxDeviceClass = 'light' | 'other';

/** Whether the stored setting value asks for the light class: only the boolean `true` does, anything else is off. */
export function resolveUseAsLight(value: unknown): boolean {
  return value === true;
}

/** The device class for the option: `light` when on, `other` (the manifest class) when off. */
export function targetDeviceClass(useAsLight: boolean): TimeboxDeviceClass {
  return useAsLight ? 'light' : 'other';
}
