import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

// `@/` mirrors the tsconfig path alias so route tests can import app/api/** unchanged.
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
  test: { exclude: [...configDefaults.exclude, '.claude/**'] },
});
