import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    // Electron's main and sandboxed preload entry points intentionally use CommonJS.
    files: ["desktop/main.js", "desktop/preload.js"],
    languageOptions: { sourceType: "commonjs" },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    files: ["scripts/**/*.mjs"],
    rules: { "no-undef": "error" },
  },
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
      // FastAPI runner's own frontend (compiled into static/), not part of the Next app.
      "src/**",
      "static/**",
      // Unmodified, checksum-pinned upstream AudioWorklet assets (see docs/voice-csp-worklets.md).
      "public/vendor/elevenlabs/1.27.0/*.js",
      "public/vendor/libsamplerate/2.1.2/*.js",
    ],
  },
];

export default eslintConfig;
