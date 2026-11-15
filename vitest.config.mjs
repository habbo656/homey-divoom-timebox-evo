import { configDefaults, defineConfig } from 'vitest/config';

// macOS writes AppleDouble files (`._name`) next to every file on non-APFS volumes; they are not test files.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, '**/._*'] },
});
