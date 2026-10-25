import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(new URL('../.github/workflows/desktop.yml', import.meta.url), 'utf8');

describe('desktop CI workflow', () => {
  it('builds installers for macOS, Windows and Linux plus the Android APK', () => {
    for (const needle of ['macos-latest', '--mac dmg zip', 'windows-latest', '--win nsis portable', 'ubuntu-latest', '--linux AppImage', 'assembleRelease']) {
      expect(workflow).toContain(needle);
    }
  });

  it('never publishes unsigned artifacts silently: uploads are per-OS run artifacts', () => {
    expect(workflow).toContain('actions/upload-artifact@v4');
    expect(workflow).toContain('if-no-files-found: error');
  });

  it('ships only a release-signed Android build, never the debug one', () => {
    expect(workflow).not.toContain('assembleDebug');
    expect(workflow).not.toMatch(/apk\/debug\//);
    expect(workflow).toContain('secrets.MUOP_ANDROID_KEYSTORE_B64');
    expect(workflow).toContain('apksigner" verify');
  });
});
