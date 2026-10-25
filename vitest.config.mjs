import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Release validation must never load checkout .env files (explicit process env still applies).
export default defineConfig({
  envDir: false,
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
  oxc: { jsx: { runtime: 'automatic' } },
});
