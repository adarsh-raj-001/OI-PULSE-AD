import assert from 'node:assert/strict';
import { decodeDhanFeedPacket } from './dhanLiveFeed.js';

const full = Buffer.alloc(162);
full.writeUInt8(8, 0); // response code: Full Packet
full.writeUInt16LE(162, 1);
full.writeUInt8(2, 3); // NSE_FNO
full.writeInt32LE(49081, 4);
full.writeFloatLE(368.15, 8);
full.writeUInt16LE(75, 12);
full.writeUInt32LE(1_700_000_000, 14);
full.writeFloatLE(367.4, 18);
full.writeUInt32LE(123_456, 22);
full.writeUInt32LE(20_000, 26);
full.writeUInt32LE(21_000, 30);
full.writeUInt32LE(987_654, 34);
full.writeUInt32LE(1_000_000, 38);
full.writeUInt32LE(900_000, 42);
full.writeUInt32LE(1_500, 62);
full.writeUInt32LE(1_200, 66);
full.writeUInt16LE(12, 70);
full.writeUInt16LE(10, 72);
full.writeFloatLE(368.1, 74);
full.writeFloatLE(368.2, 78);

const decoded = decodeDhanFeedPacket(full, 1_700_000_123_000);
assert.equal(decoded.type, 'full');
assert.equal(decoded.exchangeSegment, 'NSE_FNO');
assert.equal(decoded.securityId, 49081);
assert.equal(Number(decoded.lastPrice.toFixed(2)), 368.15);
assert.equal(decoded.oi, 987_654);
assert.equal(decoded.volume, 123_456);
assert.equal(decoded.depth.length, 5);
assert.equal(decoded.depth[0].bidQuantity, 1_500);
assert.equal(Number(decoded.depth[0].askPrice.toFixed(2)), 368.2);

const ticker = Buffer.alloc(16);
ticker.writeUInt8(2, 0);
ticker.writeUInt8(0, 3);
ticker.writeInt32LE(13, 4);
ticker.writeFloatLE(24_252.5, 8);
ticker.writeUInt32LE(1_700_000_001, 12);
const index = decodeDhanFeedPacket(ticker, 1_700_000_002_000);
assert.equal(index.type, 'ticker');
assert.equal(index.exchangeSegment, 'IDX_I');
assert.equal(index.lastPrice, 24_252.5);

const disconnect = Buffer.alloc(10);
disconnect.writeUInt8(50, 0);
disconnect.writeUInt8(2, 3);
disconnect.writeInt32LE(49081, 4);
disconnect.writeUInt16LE(807, 8);
assert.deepEqual(decodeDhanFeedPacket(disconnect, 1).disconnectCode, 807);
assert.equal(decodeDhanFeedPacket(Buffer.alloc(4)).type, 'invalid');

console.log('dhan-live-feed tests passed');
