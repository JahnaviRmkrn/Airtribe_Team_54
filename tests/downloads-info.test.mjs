import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('write-downloads-info script', () => {
  it('manifest matches the files on disk (name, size, sha256, label)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'muop-downloads-'));
    writeFileSync(join(dir, 'Muop-9.9.9.AppImage'), 'fake-appimage-bytes');
    writeFileSync(join(dir, 'notes.txt'), 'not an installer');
    execFileSync(process.execPath, [new URL('../scripts/write-downloads-info.mjs', import.meta.url).pathname, dir]);

    const manifest = JSON.parse(readFileSync(join(dir, 'downloads.json'), 'utf8'));
    expect(manifest.files).toHaveLength(1);
    const [file] = manifest.files;
    expect(file.name).toBe('Muop-9.9.9.AppImage');
    expect(file.label).toBe('Linux (AppImage)');
    expect(file.bytes).toBe(19);
    expect(file.sha256).toBe(createHash('sha256').update('fake-appimage-bytes').digest('hex'));
  });
});
