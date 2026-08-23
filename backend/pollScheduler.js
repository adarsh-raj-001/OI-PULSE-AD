export function nextPollDelayMs({ startedAt, finishedAt, minimumIntervalMs, retryAfterMs = 0 }) {
  const elapsedMs = Math.max(0, Number(finishedAt) - Number(startedAt));
  const cadenceDelayMs = Math.max(0, Number(minimumIntervalMs) - elapsedMs);
  return Math.max(cadenceDelayMs, Number(retryAfterMs) || 0);
}

/**
 * Runs exactly one REST snapshot at a time. The next symbol is scheduled only
 * after the prior request settles, ensuring the configured interval is global
 * across NIFTY, SENSEX, and any future symbols.
 */
export class SerializedPollScheduler {
  constructor({ symbols, minimumIntervalMs, run, now = () => Date.now(), schedule = setTimeout }) {
    this.symbols = symbols || [];
    this.minimumIntervalMs = minimumIntervalMs;
    this.run = run;
    this.now = now;
    this.schedule = schedule;
    this.index = 0;
    this.running = false;
    this.timer = null;
  }

  start() {
    if (this.running || !this.symbols.length) return;
    this.running = true;
    this.tick();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async tick() {
    if (!this.running) return;
    const symbol = this.symbols[this.index];
    this.index = (this.index + 1) % this.symbols.length;
    const startedAt = this.now();
    let retryAfterMs = 0;
    try {
      const result = await this.run(symbol);
      retryAfterMs = Number(result?.retryAfterMs) || 0;
    } catch (error) {
      retryAfterMs = Number(error?.retryAfterMs) || 0;
    }
    const delay = nextPollDelayMs({
      startedAt,
      finishedAt: this.now(),
      minimumIntervalMs: this.minimumIntervalMs,
      retryAfterMs,
    });
    this.timer = this.schedule(() => this.tick(), delay);
  }
}
