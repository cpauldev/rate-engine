import type { RateLimitDecision } from "./types";

/**
 * Calculates the retry-after duration in seconds from the reset timestamp.
 *
 * @param reset The Unix timestamp in milliseconds when the rate limit resets.
 * @returns The number of seconds (minimum 1) until the reset time.
 */
function getRetryAfterSeconds(reset: number): number {
  return Math.max(1, Math.ceil((reset - Date.now()) / 1000));
}

/**
 * Generates standard rate limit response headers.
 *
 * @param decision Object containing the current rate limit status.
 * @returns An object map of rate limit headers (keys are case-insensitive HTTP headers).
 */
export function getRateLimitHeaders(decision: {
  limit: number;
  remaining: number;
  reset: number;
}): Record<string, string> {
  const resetSeconds = getRetryAfterSeconds(decision.reset);

  return {
    "RateLimit-Limit": String(decision.limit),
    "RateLimit-Remaining": String(decision.remaining),
    "RateLimit-Reset": String(resetSeconds),
  };
}

/**
 * Formats a standard 429 Too Many Requests response with a JSON payload.
 *
 * @param decision The rate limit decision details.
 * @param options Customization overrides like a custom user-facing message or errorCode.
 * @returns A Web standard Response object configured with the 429 status and headers.
 */
export function toRateLimitResponse(
  decision: RateLimitDecision,
  options?: { message?: string; errorCode?: string },
): Response {
  const retryAfter = getRetryAfterSeconds(decision.reset);
  const message =
    options?.message ??
    decision.message ??
    "Too many requests. Please try again later.";

  const body = JSON.stringify({
    error: options?.errorCode ?? "RATE_LIMIT_EXCEEDED",
    message,
    retryAfter,
    degraded: decision.degraded,
  });

  return new Response(body, {
    status: 429,
    headers: {
      "Content-Type": "application/json",
      "Retry-After": String(retryAfter),
      ...getRateLimitHeaders(decision),
    },
  });
}

/**
 * Formats an RFC-compliant OAuth 2.0 slow_down error response with a JSON payload.
 * Useful for device flows, client polling endpoints, or slow-down API endpoints.
 *
 * @param decision The rate limit decision details.
 * @param options Custom message override.
 * @returns A Web standard Response object configured with the 429 status and headers.
 */
export function toOAuthSlowDownResponse(
  decision: RateLimitDecision,
  options?: { message?: string },
): Response {
  const retryAfter = getRetryAfterSeconds(decision.reset);
  const body = JSON.stringify({
    error: "slow_down",
    error_description:
      options?.message ??
      decision.message ??
      "Polling too frequently. Please wait before trying again.",
    retry_after: retryAfter,
    degraded: decision.degraded,
  });

  return new Response(body, {
    status: 429,
    headers: {
      "Content-Type": "application/json",
      "Retry-After": String(retryAfter),
    },
  });
}
