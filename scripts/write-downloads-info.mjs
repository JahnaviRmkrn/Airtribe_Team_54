#!/usr/bin/env node
// Write public/downloads/downloads.json describing the installer files
// actually present, so the landing page shows true sizes/checksums.
// Usage: node scripts/write-downloads-info.mjs [downloads-dir]
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'downloads');
const LABELS = { '.zip': 'Windows (.zip)', '.AppImage': 'Linux (AppImage)', '.apk': 'Android (.apk)', '.dmg': 'macOS (.dmg)', '.exe': 'Windows (.exe)' };

const files = readdirSync(dir)
  .filter((name) => /\.(zip|AppImage|apk|dmg|exe)$/.test(name))
  // Debug Android builds are debuggable and signed with the shared debug key
  // (session cookies readable over adb): never list them for download.
  .filter((name) => !/debug/i.test(name))
  .sort()
  .map((name) => {
    const data = readFileSync(join(dir, name));
    const ext = name.slice(name.lastIndexOf('.'));
    let label = ext === '.exe' && name.includes('Setup') ? 'Windows (installer)' : LABELS[ext] || name;
    if (name.includes('-mac') || ext === '.dmg') label = ext === '.dmg' ? 'macOS (.dmg)' : 'macOS (.zip)';
    if (name.includes('arm64')) label += ' · Apple Silicon';
    return {
      name,
      label,
      bytes: statSync(join(dir, name)).size,
      sha256: createHash('sha256').update(data).digest('hex'),
    };
  });

writeFileSync(join(dir, 'downloads.json'), JSON.stringify({ generatedAt: new Date().toISOString(), files }, null, 2) + '\n');
console.log(`downloads.json: ${files.length} file(s) in ${dir}`);
