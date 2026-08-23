import WebSocket from 'ws';

const FEED_URL = 'wss://api-feed.dhan.co';
const FULL_PACKET_SUBSCRIBE = 21;
const FULL_PACKET_UNSUBSCRIBE = 22;

const SEGMENT_BY_CODE = {
  0: 'IDX_I',
  1: 'NSE_EQ',
  2: 'NSE_FNO',
  3: 'NSE_CURRENCY',
  4: 'BSE_EQ',
  5: 'MCX_COMM',
  7: 'BSE_CURRENCY',
  8: 'BSE_FNO',
};

const finite = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

function messageBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

function parseDepth(buffer, offset) {
  const depth = [];
  for (let level = 0; level < 5; level += 1) {
    const start = offset + level * 20;
    if (buffer.length < start + 20) break;
    depth.push({
      bidQuantity: buffer.readUInt32LE(start),
      askQuantity: buffer.readUInt32LE(start + 4),
      bidOrders: buffer.readUInt16LE(start + 8),
      askOrders: buffer.readUInt16LE(start + 10),
      bidPrice: buffer.readFloatLE(start + 12),
      askPrice: buffer.readFloatLE(start + 16),
    });
  }
  return depth;
}

/**
 * Decode the documented Dhan v2 market-feed packets used by OI Pulse.
 * The feed is binary little-endian; unknown packets are passed through with
 * their response code so they are observable without being mistaken for data.
 */
export function decodeDhanFeedPacket(data, receivedAt = Date.now()) {
  const buffer = messageBuffer(data);
  if (!buffer || buffer.length < 8) return { type: 'invalid', receivedAt };

  const responseCode = buffer.readUInt8(0);
  const exchangeSegment = SEGMENT_BY_CODE[buffer.readUInt8(3)] || `UNKNOWN_${buffer.readUInt8(3)}`;
  const securityId = buffer.readInt32LE(4);
  const base = { responseCode, exchangeSegment, securityId, receivedAt };

  // Index packets use the same initial price position as a ticker in current
  // Dhan feeds. Keep the response code explicit so the caller can fall back to
  // the option-chain underlying price if a broker-side format changes.
  if ((responseCode === 1 || responseCode === 2) && buffer.length >= 16) {
    return {
      ...base,
      type: responseCode === 1 ? 'index' : 'ticker',
      lastPrice: finite(buffer.readFloatLE(8)),
      lastTradeTime: buffer.readUInt32LE(12),
    };
  }

  if (responseCode === 4 && buffer.length >= 50) {
    return {
      ...base,
      type: 'quote',
      lastPrice: finite(buffer.readFloatLE(8)),
      lastTradeTime: buffer.readUInt32LE(14),
      averagePrice: finite(buffer.readFloatLE(18)),
      volume: buffer.readUInt32LE(22),
      totalSellQuantity: buffer.readUInt32LE(26),
      totalBuyQuantity: buffer.readUInt32LE(30),
    };
  }

  if (responseCode === 5 && buffer.length >= 12) {
    return { ...base, type: 'oi', oi: buffer.readUInt32LE(8) };
  }

  if (responseCode === 8 && buffer.length >= 162) {
    return {
      ...base,
      type: 'full',
      lastPrice: finite(buffer.readFloatLE(8)),
      lastTradedQuantity: buffer.readUInt16LE(12),
      lastTradeTime: buffer.readUInt32LE(14),
      averagePrice: finite(buffer.readFloatLE(18)),
      volume: buffer.readUInt32LE(22),
      totalSellQuantity: buffer.readUInt32LE(26),
      totalBuyQuantity: buffer.readUInt32LE(30),
      oi: buffer.readUInt32LE(34),
      oiDayHigh: buffer.readUInt32LE(38),
      oiDayLow: buffer.readUInt32LE(42),
      depth: parseDepth(buffer, 62),
    };
  }

  if (responseCode === 50 && buffer.length >= 10) {
    return { ...base, type: 'disconnect', disconnectCode: buffer.readUInt16LE(8) };
  }

  return { ...base, type: 'ignored' };
}

function instrumentKey(instrument) {
  return `${instrument.exchangeSegment}:${instrument.securityId}`;
}

function subscriptionMessages(code, instruments) {
  const chunks = [];
  for (let index = 0; index < instruments.length; index += 100) {
    const chunk = instruments.slice(index, index + 100);
    chunks.push(JSON.stringify({
      RequestCode: code,
      InstrumentCount: chunk.length,
      InstrumentList: chunk.map(({ exchangeSegment, securityId }) => ({
        ExchangeSegment: exchangeSegment,
        SecurityId: String(securityId),
      })),
    }));
  }
  return chunks;
}

/**
 * Owns exactly one Dhan v2 live-feed connection. It is deliberately server
 * side: Dhan credentials never reach the browser; OI Pulse still fan-outs to
 * clients through its existing SSE endpoint.
 */
export class DhanLiveFeed {
  constructor({ getCredentials, onPacket, onStatus, reconnectMaxMs = 30_000 }) {
    this.getCredentials = getCredentials;
    this.onPacket = onPacket;
    this.onStatus = onStatus || (() => {});
    this.reconnectMaxMs = reconnectMaxMs;
    this.desired = new Map();
    this.active = new Map();
    this.socket = null;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.stopped = true;
    this.lastEventAt = null;
  }

  status(state, extra = {}) {
    this.onStatus({ state, lastEventAt: this.lastEventAt, ...extra });
  }

  setSubscriptions(instruments) {
    this.desired = new Map((instruments || [])
      .filter((instrument) => instrument?.exchangeSegment && finite(instrument?.securityId) !== null)
      .map((instrument) => [instrumentKey(instrument), instrument]));
    if (this.socket?.readyState === WebSocket.OPEN) this.syncSubscriptions();
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    if (this.desired.size) this.connect();
    else this.status('waiting');
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.socket) this.socket.close();
    this.socket = null;
    this.active.clear();
    this.status('disabled');
  }

  async connect(forceRefresh = false) {
    if (this.stopped || !this.desired.size || this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) return;
    try {
      this.status('connecting');
      const { clientId, accessToken } = await this.getCredentials(forceRefresh);
      if (!clientId || !accessToken) throw new Error('Dhan live feed credentials are unavailable');
      const url = `${FEED_URL}?version=2&token=${encodeURIComponent(accessToken)}&clientId=${encodeURIComponent(clientId)}&authType=2`;
      const socket = new WebSocket(url);
      this.socket = socket;
      socket.on('open', () => {
        if (socket !== this.socket) return;
        this.reconnectAttempt = 0;
        this.active.clear();
        this.status('connected');
        this.syncSubscriptions();
      });
      socket.on('message', (data) => {
        if (socket !== this.socket) return;
        const packet = decodeDhanFeedPacket(data);
        if (packet.type === 'disconnect') {
          this.status('reconnecting', { reason: `Dhan feed disconnect ${packet.disconnectCode}` });
          if (packet.disconnectCode === 807 || packet.disconnectCode === 808 || packet.disconnectCode === 809) socket.terminate();
          return;
        }
        if (packet.type === 'ignored' || packet.type === 'invalid') return;
        this.lastEventAt = packet.receivedAt;
        this.onPacket(packet);
        this.status('connected');
      });
      socket.on('error', () => {}); // close event owns retry scheduling
      socket.on('close', (_code, reason) => {
        if (socket !== this.socket) return;
        this.socket = null;
        this.active.clear();
        this.scheduleReconnect(String(reason || 'connection closed'));
      });
    } catch (error) {
      this.scheduleReconnect(error.message);
    }
  }

  syncSubscriptions() {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    const remove = [...this.active.entries()].filter(([key]) => !this.desired.has(key)).map(([, value]) => value);
    const add = [...this.desired.entries()].filter(([key]) => !this.active.has(key)).map(([, value]) => value);
    for (const message of subscriptionMessages(FULL_PACKET_UNSUBSCRIBE, remove)) this.socket.send(message);
    for (const instrument of remove) this.active.delete(instrumentKey(instrument));
    for (const message of subscriptionMessages(FULL_PACKET_SUBSCRIBE, add)) this.socket.send(message);
    for (const instrument of add) this.active.set(instrumentKey(instrument), instrument);
  }

  scheduleReconnect(reason) {
    if (this.stopped || this.reconnectTimer) return;
    const base = Math.min(this.reconnectMaxMs, 1_000 * 2 ** this.reconnectAttempt);
    const delay = Math.round(base * (0.75 + Math.random() * 0.5));
    this.reconnectAttempt += 1;
    this.status('reconnecting', { reason, retryInMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect(this.reconnectAttempt > 1);
    }, delay);
  }
}
