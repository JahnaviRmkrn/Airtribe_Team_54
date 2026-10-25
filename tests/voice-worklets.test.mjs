import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { APP_CSP } from '../lib/csp';

const manifest = JSON.parse(readFileSync(new URL('../public/vendor/voice-assets.json', import.meta.url), 'utf8'));
const assetBytes = (path) => readFileSync(new URL('../public' + path, import.meta.url));
const directive = (name) => APP_CSP.split('; ').find((part) => part.startsWith(name + ' '));
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

function audioWorklet(sampleRate) {
  const processors = new Map();
  class AudioWorkletProcessor {
    constructor() { this.port = { postMessage: vi.fn() }; }
  }
  // Only the AudioWorklet host is mocked. The real vendored processor and
  // resampler code runs with eval/Function/Wasm code generation disabled.
  const context = vm.createContext({
    sampleRate, AudioWorkletProcessor, constructor: { name: 'AudioWorkletGlobalScope' },
    registerProcessor: (name, Processor) => processors.set(name, Processor),
  }, { codeGeneration: { strings: false, wasm: false } });
  const addModule = vi.fn(async (path) => {
    expect(path).toMatch(/^\/vendor\//);
    const source = assetBytes(path).toString('utf8');
    // Model module-local scope; only remove this pinned bundle's final ESM
    // export list, which vm.Script cannot parse. No implementation is changed.
    const script = source.replace(/export\{N as ConverterType,s as create\};$/, '');
    vm.runInContext('(function () {\n' + script + '\n})();', context, { filename: path, timeout: 5000 });
  });
  return { context, processors, addModule };
}

describe('self-hosted ElevenLabs worklets', () => {
  it('keeps the SDK pin and integrity unchanged and locks every unmodified asset', () => {
    expect(manifest.sdk.version).toBe('1.27.0');
    expect(manifest.sdk.url).toBe('https://cdn.jsdelivr.net/npm/@elevenlabs/client@1.27.0/dist/lib.iife.js');
    expect(manifest.sdk.integrity).toBe('sha384-ekuWfdL0BkeVAWv24yeCWtzVwYDQd4pCkPL5TKVDLmwDBeVxS2cTwo0wfsUNaFkJ');
    expect(manifest.assets.map((asset) => asset.sha256)).toEqual([
      '6731b766e9e6176d56b9c6964975dd7dd045db88ce3b2b0b787f5fbeb9f1325d',
      'e352f9c0e6e540baed2c16247015b997aa9f46767b3c6b0fc41afd3a5053870b',
      'ca6e162f194d3ee5a2d2cd3c3b49641d31e56845aeae507feca1cdf8aa8116cb',
    ]);
    for (const asset of manifest.assets) {
      const bytes = assetBytes(asset.path);
      expect(bytes.length).toBe(asset.bytes);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(asset.sha256);
      expect(asset.url).toMatch(/^https:\/\/cdn\.jsdelivr\.net\/npm\/@(?:elevenlabs\/client@1\.27\.0\/worklets|alexanderolsen\/libsamplerate-js@2\.1\.2\/dist)\//);
    }
  });

  it('needs only existing same-origin script permission, not blob/data, eval, Wasm or a new CDN', () => {
    const scripts = directive('script-src');
    expect(scripts.split(' ')).toContain("'self'");
    expect(scripts).not.toMatch(/blob:|data:|unsafe-eval|wasm-unsafe-eval|unsafe-inline|libsamplerate/);
    expect(directive('worker-src')).toBe("worker-src 'self'");
    for (const { path } of manifest.assets) {
      const url = new URL(path, 'https://example.test');
      expect(url.origin).toBe('https://example.test');
      expect(url.pathname).toBe(path);
      expect(assetBytes(path).toString()).not.toMatch(/\b(?:eval\s*\(|new\s+Function\s*\(|WebAssembly\b|import\s*\()/);
    }
  });

  it('registers the exact SDK processor names and handles PCM input, muting and output', async () => {
    const worklet = audioWorklet(16000);
    await worklet.addModule(manifest.assets[0].path);
    await worklet.addModule(manifest.assets[1].path);
    expect([...worklet.processors.keys()]).toEqual(['rawAudioProcessor', 'audioConcatProcessor']);
    const input = new (worklet.processors.get('rawAudioProcessor'))();
    input.port.onmessage({ data: { type: 'setFormat', format: 'pcm', sampleRate: 16000, chunkDurationMs: 8 } });
    expect(input.process([[new Float32Array(128).fill(0.5)]])).toBe(true);
    expect(Array.from(input.port.postMessage.mock.calls[0][0][0])).toEqual(Array(128).fill(16383));
    input.port.onmessage({ data: { type: 'setMuted', isMuted: true } });
    input.process([[new Float32Array(128).fill(0.5)]]);
    expect(Array.from(input.port.postMessage.mock.calls[1][0][0])).toEqual(Array(128).fill(0));

    const output = new (worklet.processors.get('audioConcatProcessor'))();
    output.port.onmessage({ data: { type: 'setFormat', format: 'pcm', sampleRate: 16000 } });
    output.port.onmessage({ data: { type: 'buffer', buffer: new Int16Array([16384, -16384]).buffer } });
    const samples = new Float32Array(2);
    expect(output.process([], [[samples]])).toBe(true);
    expect(Array.from(samples)).toEqual([0.5, -0.5]);
  });

  it('initializes the actual conditional resampler in a strict worklet and resamples both directions', async () => {
    const worklet = audioWorklet(48000);
    await worklet.addModule(manifest.assets[2].path);
    await worklet.addModule(manifest.assets[0].path);
    await worklet.addModule(manifest.assets[1].path);
    expect(typeof worklet.context.LibSampleRate.create).toBe('function');
    const input = new (worklet.processors.get('rawAudioProcessor'))();
    const output = new (worklet.processors.get('audioConcatProcessor'))();
    input.port.onmessage({ data: { type: 'setFormat', format: 'pcm', sampleRate: 16000, chunkDurationMs: 8 } });
    output.port.onmessage({ data: { type: 'setFormat', format: 'pcm', sampleRate: 16000 } });
    await flush();
    try {
      expect(input.resampler.inputSampleRate).toBe(48000);
      expect(input.resampler.outputSampleRate).toBe(16000);
      expect(output.resampler.inputSampleRate).toBe(16000);
      expect(output.resampler.outputSampleRate).toBe(48000);
      for (let i = 0; i < 12; i++) input.process([[new Float32Array(128).fill(0.5)]]);
      expect(input.port.postMessage).toHaveBeenCalled();
      output.port.onmessage({ data: { type: 'buffer', buffer: new Int16Array(128).fill(16384).buffer } });
      const samples = new Float32Array(128);
      output.process([], [[samples]]);
      expect(Array.from(samples).every(Number.isFinite)).toBe(true);
      expect(samples.some((sample) => sample > 0.4)).toBe(true);
    } finally {
      input.resampler?.destroy();
      output.resampler?.destroy();
    }
  });
});
