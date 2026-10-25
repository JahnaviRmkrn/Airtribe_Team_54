import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Inspect paths only. Never print or read the contents of an environment file.
export const trackedEnvFiles = (paths) => paths.filter((path) => {
  const name = path.split('/').at(-1);
  return (name === '.env' || name.startsWith('.env.')) && name !== '.env.example';
});

// Supabase identifies a migration by its numeric version, not its descriptive
// filename. Independent branches must not ship two names with one version.
export const duplicateMigrationVersions = (paths) => {
  const versions = new Map();
  for (const path of [...new Set(paths)].sort()) {
    const match = path.match(/^supabase\/migrations\/(\d+)_[^/]+\.sql$/);
    if (!match) continue;
    const entries = versions.get(match[1]) ?? [];
    entries.push(path);
    versions.set(match[1], entries);
  }
  return [...versions].filter(([, paths]) => paths.length > 1)
    .map(([version, paths]) => ({ version, paths }));
};

export function checkRepository() {
  const result = spawnSync('git', ['ls-files', '-z'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    // Deployment source archives may intentionally omit .git metadata.
    console.warn('Tracked-env check skipped: Git metadata is unavailable. Run pnpm check:repo in the checkout.');
    return 0;
  }
  const paths = result.stdout.split('\0').filter(Boolean);
  const unsafe = trackedEnvFiles(paths);
  if (unsafe.length) {
    console.error('Do not commit local environment files. Remove these tracked paths and rotate any exposed secrets:');
    unsafe.forEach((path) => console.error(JSON.stringify(path)));
    return 1;
  }
  const duplicateVersions = duplicateMigrationVersions(paths);
  if (duplicateVersions.length) {
    console.error('Migration versions must be unique. Rename unpublished conflicting migrations before release:');
    duplicateVersions.forEach(({ paths }) => paths.forEach((path) => console.error(JSON.stringify(path))));
    return 1;
  }
  console.log('Repository check passed: no tracked local environment files; migration versions are unique.');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = checkRepository();
}
