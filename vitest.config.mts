import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Lets tests import route handlers that use the app's "@/..." path alias.
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
});
