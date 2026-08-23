import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '..', 'frontend', 'index.html'), 'utf8');
const inlineScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
assert.ok(inlineScripts.length, 'the dashboard must have an inline JavaScript block');
assert.doesNotThrow(() => new Function(inlineScripts.at(-1)), 'dashboard inline JavaScript must parse');

assert.match(html, /function scheduleReconnect\(\)/);
assert.match(html, /capped exponential backoff|reconnecting in/);
assert.doesNotMatch(html, /startDemoMode\(\);\s*}, 4000\)/);
assert.match(html, /Volume C \/ P/);
assert.match(html, /Bid \/ ask qty · Call/);
assert.match(html, /Bid − ask qty · Call/);
assert.match(html, /Bid \/ ask qty · Put/);
assert.match(html, /Weighted bid \/ ask · C/);
assert.match(html, /lightweight-charts@5\.2\.0/);
assert.match(html, /Market history · Near-ATM order flow/);
assert.match(html, /Price \+ premiums/);
assert.match(html, /OI \+ change/);
assert.match(html, /Bid − ask/);
assert.match(html, /function loadChartHistory\(symbolName\)/);
assert.match(html, /\/api\/chart\//);
assert.match(html, /function ingestChartPoint\(point, symbolName/);
assert.match(html, /3-second OI change/);

console.log('frontend connection, aggregate, and chart contracts passed');
