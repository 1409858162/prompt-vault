// In-memory rate limiter + token bucket with sliding window.
//
// Why in-memory: this single Node process serves < 50 req/s on average;
// Redis is the production target but adds an external dep. The interface
// here is identical to the Redis bucket (key + TTL), so the swap is one file.
//
// Algorithm: token bucket. `take(key, capacity, refillPerSec)` consumes one
// token; returns { ok, remaining, resetMs }. When empty we return 429 with
// Retry-After. This is the same primitive Cloudflare / Stripe / AWS use.
const _buckets = new Map(); // key -> { tokens, lastRefill, capacity, refillPerSec }

export function take(key, capacity, refillPerSec) {
  const now = Date.now();
  const b = _buckets.get(key) || { tokens: capacity, lastRefill: now };
  const elapsed = (now - b.lastRefill) / 1000;
  b.tokens = Math.min(capacity, b.tokens + elapsed * refillPerSec);
  b.lastRefill = now;
  if (b.tokens >= 1) {
    b.tokens -= 1;
    _buckets.set(key, b);
    return { ok: true, remaining: Math.floor(b.tokens), resetMs: 0 };
  }
  _buckets.set(key, b);
  const waitMs = Math.ceil((1 - b.tokens) / refillPerSec * 1000);
  return { ok: false, remaining: 0, resetMs: waitMs };
}

// Sliding-window counter for "X requests in last N seconds".
// Used by behavior analysis (not per-request blocking).
const _windows = new Map(); // key -> [timestamps]
const WINDOW_MAX_KEYS = 5000;

export function countInWindow(key, windowMs) {
  const cutoff = Date.now() - windowMs;
  const arr = (_windows.get(key) || []).filter(t => t >= cutoff);
  _windows.set(key, arr);
  // Bounded cache eviction
  if (_windows.size > WINDOW_MAX_KEYS) {
    const oldest = [..._windows.keys()].slice(0, 500);
    for (const k of oldest) _windows.delete(k);
  }
  return arr.length;
}

export function recordHit(key) {
  const arr = _windows.get(key) || [];
  arr.push(Date.now());
  _windows.set(key, arr);
}