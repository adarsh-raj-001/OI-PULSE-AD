import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflow = await readFile(new URL('../.github/workflows/wake-market-open.yml', import.meta.url), 'utf8');

assert.match(workflow, /cron:\s*'45 3 \* \* 1-5'/, 'weekday 09:15 Asia/Kolkata wake must be scheduled at 03:45 UTC');
assert.match(workflow, /workflow_dispatch:/, 'manual workflow testing must remain available');
assert.match(workflow, /permissions:\s*\{\}/, 'the health wake must not request repository permissions');
assert.match(workflow, /https:\/\/oi-pulse-backend-60u1\.onrender\.com\/api\/health/, 'the wake must use only the public health endpoint');
assert.match(workflow, /--retry 2/, 'a Render cold start should receive bounded retry coverage');
assert.doesNotMatch(workflow, /DHAN_|OI_HISTORY_DATABASE_URL|DATABASE_URL|Authorization:/, 'the wake workflow must not contain market or database credentials');
console.log('market-open wake workflow tests passed');
