// Real HTTP evaluation; supply a signed-in session, never a service-role token.
// EXTRACT_ACCESS_TOKEN=... BASE_URL=http://localhost:3054 node scripts/evaluate-extraction.mjs
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
const cases = JSON.parse(await readFile(new URL('../fixtures/onboarding/cases.json', import.meta.url), 'utf8'));
const base = process.env.BASE_URL || 'http://localhost:3054';
const target = new URL(base);
if (!['localhost', '127.0.0.1'].includes(target.hostname) && target.protocol !== 'https:') throw new Error('Use HTTPS for remote evaluation');
let token = process.env.EXTRACT_ACCESS_TOKEN;
if (!token && process.env.EXTRACT_TEST_EMAIL && process.env.EXTRACT_TEST_PASSWORD) {
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { data, error } = await supabase.auth.signInWithPassword({ email: process.env.EXTRACT_TEST_EMAIL, password: process.env.EXTRACT_TEST_PASSWORD });
  if (error) throw new Error('Evaluation sign-in failed');
  token = data.session?.access_token;
}
if (!token) throw new Error('Set EXTRACT_ACCESS_TOKEN or EXTRACT_TEST_EMAIL and EXTRACT_TEST_PASSWORD');
const results = [];
for (const fixture of cases) {
  const start = Date.now();
  const failures = [];
  let output = null, status = null;
  try {
    const response = await fetch(new URL('/api/extract', base), {
      method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ transcript: fixture.transcript }), signal: AbortSignal.timeout(60000),
    });
    status = response.status;
    output = await response.json();
    if (!response.ok) failures.push(`HTTP ${status}`);
    else {
      if (output.saved !== false) failures.push('stateless marker');
      if (!Array.isArray(output.contacts) || output.contacts.length !== fixture.contacts.length || output.contacts.length > 5) failures.push('contact count');
      for (const [name, category, frequency] of fixture.contacts) {
        const actual = output.contacts?.find(c => c.name?.toLowerCase() === name.toLowerCase());
        if (!actual) failures.push(`missing ${name}`);
        else {
          if (actual.category !== category) failures.push(`${name}: category`);
          if ((actual.preferred_frequency_days ?? null) !== frequency) failures.push(`${name}: frequency`);
        }
      }
      for (const name of fixture.forbidden || []) if (output.contacts?.some(c => c.name?.toLowerCase() === name.toLowerCase())) failures.push(`invented ${name}`);
      const goals = output.goals || {};
      if (Object.values(goals).reduce((a,b) => a+b,0) !== 100) failures.push('goal total');
      for (const [key, value] of Object.entries(fixture.goals)) if (goals[key] !== value) failures.push(`goal ${key}`);
      if (process.env.EXPECT_SOURCE && output.source !== process.env.EXPECT_SOURCE) failures.push(`expected source ${process.env.EXPECT_SOURCE}, got ${output.source}`);
    }
  } catch (error) { failures.push(error.name === 'TimeoutError' ? 'timeout' : 'request failed'); }
  results.push({ id: fixture.id, status, duration_ms: Date.now()-start, output, failures, passed: failures.length === 0 });
  console.log(`${failures.length ? 'FAIL' : 'PASS'} ${fixture.id} (${output?.source || 'no source'}): ${failures.join(', ')}`);
}
const report = { timestamp: new Date().toISOString(), origin: target.origin, expected_source: process.env.EXPECT_SOURCE || null, passed: results.filter(r=>r.passed).length, total: cases.length, results };
await mkdir('reports', { recursive: true });
const filename = process.env.EXTRACT_REPORT || 'reports/extraction-latest.json';
await writeFile(filename, JSON.stringify(report, null, 2)+'\n');
console.log(`${report.passed}/${report.total} passed; ${filename}`);
process.exitCode = report.passed === report.total ? 0 : 1;
