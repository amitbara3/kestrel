/**
 * Circuit breaker.
 *
 * Without one, a Redis outage is worse than no cache at all: every request
 * waits for a connection timeout before falling through, so p99 collapses and
 * the event loop fills with pending sockets. The breaker converts a slow
 * failure into a fast one.
 *
 * States: closed (pass through) -> open after N consecutive failures (reject
 * immediately for a cooldown) -> half-open (let a single probe through; success
 * closes it, failure re-opens).
 */

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  cooldownMs?: number;
  now?: () => number;
  onStateChange?: (from: BreakerState, to: BreakerState) => void;
}

export class CircuitBreaker {
  private state: BreakerState = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;
  private probeInFlight = false;

  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly onStateChange: ((from: BreakerState, to: BreakerState) => void) | undefined;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.cooldownMs = options.cooldownMs ?? 10_000;
    this.now = options.now ?? Date.now;
    this.onStateChange = options.onStateChange;
  }

  /** True when a call should be attempted. Transitions open -> half-open when the cooldown elapses. */
  canAttempt(): boolean {
    if (this.state === 'closed') return true;

    if (this.state === 'open') {
      if (this.now() - this.openedAt >= this.cooldownMs) {
        this.transition('half-open');
        this.probeInFlight = true;
        return true;
      }
      return false;
    }

    // half-open: exactly one probe at a time, so a still-dead dependency does
    // not receive the full request volume the instant the cooldown expires.
    if (this.probeInFlight) return false;
    this.probeInFlight = true;
    return true;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.probeInFlight = false;
    if (this.state !== 'closed') this.transition('closed');
  }

  recordFailure(): void {
    this.probeInFlight = false;

    if (this.state === 'half-open') {
      this.openedAt = this.now();
      this.transition('open');
      return;
    }

    this.consecutiveFailures++;
    if (this.state === 'closed' && this.consecutiveFailures >= this.failureThreshold) {
      this.openedAt = this.now();
      this.transition('open');
    }
  }

  get isClosed(): boolean {
    return this.state === 'closed';
  }

  get current(): BreakerState {
    return this.state;
  }

  get failures(): number {
    return this.consecutiveFailures;
  }

  private transition(to: BreakerState): void {
    const from = this.state;
    if (from === to) return;
    this.state = to;
    if (to === 'closed') this.consecutiveFailures = 0;
    this.onStateChange?.(from, to);
  }
}
