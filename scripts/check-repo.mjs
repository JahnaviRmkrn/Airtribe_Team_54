import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Inspect paths only. Never print or read the contents of an environment file.
export const trackedEnvFiles = (paths) => paths.filter((path) => {
  const name = path.split('/').at(-1);
  return (name === '.env' || name.startsWith('.env.')) && name !== '.env.example';
});

export function checkRepository() {
  const result = spawnSync('git', ['ls-files', '-z'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    // Deployment source archives may intentionally omit .git metadata.
    console.warn('Tracked-env check skipped: Git metadata is unavailable. Run pnpm check:repo in the checkout.');
    return 0;
  }
  const unsafe = trackedEnvFiles(result.stdout.split('\0').filter(Boolean));
  if (unsafe.length) {
    console.error('Do not commit local environment files. Remove these tracked paths and rotate any exposed secrets:');
    unsafe.forEach((path) => console.error(JSON.stringify(path)));
    return 1;
  }
  console.log('Repository check passed: no tracked local environment files.');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = checkRepository();
}
