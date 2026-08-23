import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '..', 'frontend', 'index.html'), 'utf8');

assert.match(html, /function scheduleReconnect\(\)/);
assert.match(html, /capped exponential backoff|reconnecting in/);
assert.doesNotMatch(html, /startDemoMode\(\);\s*}, 4000\)/);
assert.match(html, /Volume C \/ P/);
assert.match(html, /Bid \/ ask qty · Call/);
assert.match(html, /Bid − ask qty · Call/);
assert.match(html, /Bid \/ ask qty · Put/);
assert.match(html, /Weighted bid \/ ask · C/);

console.log('frontend connection and aggregate contract tests passed');
