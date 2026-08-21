/**
 * Lua scripts for the two rate limiters.
 *
 * Atomicity is the entire point. Redis runs Lua single-threaded, so a script
 * cannot interleave with another replica's script — check-then-write becomes
 * one indivisible step. Doing the same thing with separate GET and SET commands
 * would let two replicas both read "59 of 60 used" and both allow a request.
 *
 * `now` is passed in by the caller rather than read via redis.call('TIME')
 * because a script that reads server state is non-deterministic and historically
 * unsafe to replicate. The cost is that replica clock skew shifts window
 * boundaries slightly, which is acceptable for rate limiting and is why NTP is
 * a documented deployment requirement.
 *
 * Both scripts return: { allowed, limit, remaining, resetAt, retryAfterMs }.
 */

/**
 * Sliding-window log.
 *
 * A sorted set holds one member per request scored by timestamp. Trim what has
 * aged out, count what is left, admit if under the limit. Exact — no
 * fixed-window boundary burst where 2x the limit passes across a window edge.
 */
export const SLIDING_WINDOW_LUA = `
local key      = KEYS[1]
local now      = tonumber(ARGV[1])
local window   = tonumber(ARGV[2])
local limit    = tonumber(ARGV[3])
local member   = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local used = redis.call('ZCARD', key)

local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local resetAt = now + window
if oldest[2] then
  resetAt = tonumber(oldest[2]) + window
end

if used >= limit then
  redis.call('PEXPIRE', key, window)
  local retry = resetAt - now
  if retry < 1 then retry = 1 end
  return { 0, limit, 0, resetAt, retry }
end

redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, window)

if used == 0 then
  resetAt = now + window
end

return { 1, limit, limit - used - 1, resetAt, 0 }
`;

/**
 * Token bucket.
 *
 * Two fields, refilled lazily from elapsed time — no background timer and O(1)
 * memory per identity regardless of rate. Tolerates bursts up to `capacity`,
 * which is the correct shape for redirects: a link hits a mailing list and a
 * thousand legitimate clicks arrive in one second.
 *
 * Tokens are stored as a float; only the reported remaining count is floored,
 * so fractional refill is not repeatedly rounded away.
 */
export const TOKEN_BUCKET_LUA = `
local key      = KEYS[1]
local now      = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local refill   = tonumber(ARGV[3])
local cost     = tonumber(ARGV[4])

local state  = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts     = tonumber(state[2])

if tokens == nil or ts == nil then
  tokens = capacity
  ts = now
end

local elapsed = now - ts
if elapsed < 0 then elapsed = 0 end

tokens = math.min(capacity, tokens + (elapsed / 1000.0) * refill)

local allowed = 0
local retry = 0

if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retry = math.ceil(((cost - tokens) / refill) * 1000.0)
  if retry < 1 then retry = 1 end
end

redis.call('HSET', key, 'tokens', tokens, 'ts', now)

-- Expire an idle bucket once it would have refilled to full anyway; this is
-- what stops the limiter key space from growing without bound (Rules.md §4).
local ttl = math.ceil((capacity / refill) * 1000.0) + 1000
redis.call('PEXPIRE', key, ttl)

local msToFull = math.ceil(((capacity - tokens) / refill) * 1000.0)
return { allowed, capacity, math.floor(tokens), now + msToFull, retry }
`;
