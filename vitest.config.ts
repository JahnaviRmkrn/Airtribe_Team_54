import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Same "@/..." alias as tsconfig, so route handlers can be imported in tests.
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
});
