import assert from 'node:assert/strict';
import { normalizeLeg } from './dataSources/dhanNormalization.js';

assert.equal(normalizeLeg({ oi: null }).oi, null, 'a null Dhan OI field must remain unavailable');
assert.equal(normalizeLeg({}).oi, null, 'an omitted Dhan OI field must remain unavailable');
assert.equal(normalizeLeg({ oi: 0 }).oi, 0, 'a genuine source zero remains a valid OI value');
assert.equal(normalizeLeg({ oi: '1250' }).oi, 1250, 'numeric source strings are normalized safely');

console.log('Dhan normalization tests passed');
