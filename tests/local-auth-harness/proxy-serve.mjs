import { builtStaticPaths, createAuthProxy } from './proxy.mjs';

const proxy = createAuthProxy({ staticPaths: await builtStaticPaths('.next/static') });
const origin = await proxy.listen();
console.log(`LOCAL_AUTH_PROXY_READY ${origin}/login`);
console.log('Fixed upstream 127.0.0.1:4321; synthetic auth 127.0.0.1:4318. Stops after 30 minutes.');
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  clearTimeout(timer);
  await proxy.close();
  // Counts only, never paths, query codes, bodies, cookies, or credentials.
  console.log('LOCAL_AUTH_PROXY_COUNTS ' + JSON.stringify(proxy.snapshot()));
  if (proxy.snapshot().acceptance_failed) process.exitCode = 1;
};
const timer = setTimeout(stop, 30 * 60 * 1000);
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
