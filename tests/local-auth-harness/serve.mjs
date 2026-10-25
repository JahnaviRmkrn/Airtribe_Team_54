import { createAuthFixture } from './fixture.mjs';

const fixture = createAuthFixture();
const origin = await fixture.listen();
console.log(`LOCAL_AUTH_FIXTURE_READY ${origin}/__fixture/`);
console.log('Synthetic auth only; app origin must be http://127.0.0.1:4320. Stops after 30 minutes.');
let stopping = false;
const stop = async () => { if (stopping) return; stopping = true; clearTimeout(timer); await fixture.close(); };
const timer = setTimeout(stop, 30 * 60 * 1000);
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
