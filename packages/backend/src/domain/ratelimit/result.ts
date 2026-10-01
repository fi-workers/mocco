import type { RateLimitResult, RateLimitRule } from '@backend/domain/ratelimit/ports';

/** The result of a window whose count is now `count`. */
export function resultOf(count: number, rule: RateLimitRule, windowStart: Date): RateLimitResult {
  return {
    allowed: count <= rule.limit,
    remaining: Math.max(0, rule.limit - count),
    resetAt: new Date(windowStart.getTime() + rule.windowSeconds * 1000),
  };
}
