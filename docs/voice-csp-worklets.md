# ElevenLabs AudioWorklets under the organizer's strict CSP

The organizer keeps `@elevenlabs/client@1.27.0` and its existing SHA-384 SRI
unchanged. Its signed-URL session uses WebSocket audio, which loads input and
output AudioWorklets. The SDK's default runtime `blob:`/`data:` modules are
incompatible with the organizer's file-only `script-src` policy.

`public/organizer/voice.js` now supplies the SDK's supported `workletPaths`
(`rawAudioProcessor` and `audioConcatProcessor`) and `libsampleratePath` options.
All three paths are absolute same-origin files under `public/vendor/`. The
conditional resampler is required when sample-rate constraints are unavailable,
or the output audio context's actual sample rate differs from the requested one.
It must not silently fall back to a second, unapproved CDN origin.

No CSP directive, SDK version, provider configuration, permission request, or
server-side credential handling changed. In particular, `script-src` still
forbids `blob:`, `data:`, inline scripts, eval, and WebAssembly code generation;
`worker-src` remains `'self'`. The resampler's published **worklet** build is
self-contained JavaScript, not its separate WebAssembly build. No `.wasm` file,
extra network request, or `wasm-unsafe-eval` permission is needed.

## Upstream sources and integrity

The runtime assets are unmodified upstream bytes. Exact source URLs, byte counts
and SHA-256 hashes are recorded in
[`public/vendor/voice-assets.json`](../public/vendor/voice-assets.json).
The manifest also records the existing SDK URL and SHA-384 SRI. The processor
and resampler hashes were checked against jsDelivr's versioned npm file metadata:

- [ElevenLabs 1.27.0 file checksums](https://data.jsdelivr.com/v1/package/npm/@elevenlabs/client@1.27.0/flat)
- [libsamplerate-js 2.1.2 file checksums](https://data.jsdelivr.com/v1/package/npm/@alexanderolsen/libsamplerate-js@2.1.2/flat)

Git attributes preserve these files' exact bytes across platforms and retain
the upstream input processor's trailing whitespace. ESLint excludes only the
versioned vendor JavaScript; checksum and execution tests cover it instead.

The processor files additionally match the strings embedded in the exact,
SRI-verified `1.27.0/dist/lib.iife.js`. That same bundle explicitly forwards
`workletPaths` and `libsampleratePath` to its WebSocket input/output setup. Its
custom-path loader throws on a failed static module load instead of trying a
`blob:`/`data:` fallback.

Primary references:

- [Pinned SDK documentation, including self-hosting AudioWorklets](https://cdn.jsdelivr.net/npm/@elevenlabs/client@1.27.0/README.md)
- [Pinned SDK IIFE implementation](https://cdn.jsdelivr.net/npm/@elevenlabs/client@1.27.0/dist/lib.iife.js)
- [Upstream self-hosting instructions](https://github.com/elevenlabs/packages/blob/main/packages/client/README.md#self-hosting-audioworklets-under-a-strict-csp)
- [Pinned resampler package](https://cdn.jsdelivr.net/npm/@alexanderolsen/libsamplerate-js@2.1.2/package.json)

## Redistribution notices

Keep these notices with the assets:

- `public/vendor/elevenlabs/1.27.0/LICENSE`: ElevenLabs MIT license, copied from
  the [versioned npm package](https://cdn.jsdelivr.net/npm/@elevenlabs/client@1.27.0/LICENSE).
- `public/vendor/elevenlabs/1.27.0/LICENSE.wavefile`: MIT license for the WaveFile
  mu-law encoding/decoding code attributed in the processors' original headers,
  copied from [WaveFile's upstream license](https://raw.githubusercontent.com/rochars/wavefile/master/LICENSE).
- `public/vendor/libsamplerate/2.1.2/LICENSE.md`: the complete
  [versioned package license file](https://cdn.jsdelivr.net/npm/@alexanderolsen/libsamplerate-js@2.1.2/LICENSE.md),
  containing both Alexander Olsen's MIT notice and the embedded libsamplerate
  library's two-clause BSD notice.

## Verification and updates

`tests/voice-worklets.test.mjs` locks the original SDK pin and all three asset
checksums, checks that the existing CSP allows their same-origin paths, registers
the actual processor implementations, exercises PCM input/muting/output, and runs
both directions of the actual resampler with dynamic code generation disabled.
The VM test models AudioWorklet globals and module-local scope; it removes only
the resampler's final ESM export list because `vm.Script` does not parse ESM.

`tests/organizer-voice.test.mjs` executes the actual widget with synthetic
providers. It verifies the SDK's lazy SRI script load, exact session option names
and URLs, module failure with typed extraction and retry, repeated taps, leaving
before SDK load/session startup, and closing late sessions without stale UI
callbacks. Existing recording-fallback tests continue to cover provider 503s,
denial, setup failure, retry, double-click, stop, and navigation cleanup.

These tests use no real microphone, provider, account, or database. They do not
claim a live browser/device conversation passed. Serve the versioned files as
JavaScript; Next's normal `public/` handling supplies the correct content type.

For an intentional SDK upgrade, review the new exact package's API and published
processors first. Replace the complete versioned asset set, licenses, manifest,
session paths, SRI, CSP SDK pin, and regression expectations together. Do not
rewrite/minify vendor files or relax CSP to hide a missing asset. A failed module
load should keep typed onboarding available, not request broader permissions.
