import assert from 'node:assert/strict';
import fs from 'node:fs';

const server = fs.readFileSync(new URL('./server.js', import.meta.url), 'utf8');

assert.match(server, /const SESSION_RESET_RETRY_MS = 30_000;/);
assert.match(server, /paperStorage\?\.status === 'ready'/);
assert.match(server, /if \(err\?\.statusCode !== 503\) throw err;/);
assert.match(server, /deferredSessionResetKey = next\.localDate;/);
assert.match(server, /nextSessionResetRetryAt = timestamp \+ SESSION_RESET_RETRY_MS;/);
assert.match(server, /session-reset\] deferred/);

console.log('startup session-reset guard tests passed');
