import { describe, expect, it } from "bun:test";

import {
  getRateLimitHeaders,
  toOAuthSlowDownResponse,
  toRateLimitResponse,
} from "../http";
import { createDecision } from "./test-utils";

describe("HTTP helpers", () => {
  describe("getRateLimitHeaders", () => {
    it("emits standard rate limit headers", () => {
      const reset = Date.now() + 60_000;

      const headers = getRateLimitHeaders({
        limit: 100,
        remaining: 42,
        reset,
      });

      expect(headers["RateLimit-Limit"]).toBe("100");
      expect(headers["RateLimit-Remaining"]).toBe("42");
      expect(Number(headers["RateLimit-Reset"])).toBeGreaterThanOrEqual(59);
      expect(Number(headers["RateLimit-Reset"])).toBeLessThanOrEqual(60);
      expect(headers["X-RateLimit-Limit"]).toBeUndefined();
    });

    it("floors relative reset seconds at 1 for current or past reset times", () => {
      const headers = getRateLimitHeaders({
        limit: 100,
        remaining: 0,
        reset: Date.now() - 10_000,
      });

      expect(headers["RateLimit-Reset"]).toBe("1");
    });
  });

  describe("toRateLimitResponse", () => {
    it("returns a standard 429 JSON response with default values", async () => {
      const decision = createDecision({
        limit: 100,
        remaining: 0,
        reset: Date.now() + 30_000,
        degraded: true,
      });

      const response = toRateLimitResponse(decision);
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(response.headers.get("Content-Type")).toBe("application/json");
      expect(response.headers.get("Retry-After")).not.toBeNull();
      expect(response.headers.get("RateLimit-Remaining")).toBe("0");
      expect(response.headers.get("X-RateLimit-Limit")).toBeNull();
      expect(body).toMatchObject({
        error: "RATE_LIMIT_EXCEEDED",
        message: "Too many requests. Please try again later.",
        degraded: true,
      });
      expect(body.retryAfter).toBeGreaterThanOrEqual(29);
      expect(body.retryAfter).toBeLessThanOrEqual(30);
    });

    it("honors custom message and error code", async () => {
      const response = toRateLimitResponse(createDecision(), {
        message: "Custom message",
        errorCode: "CUSTOM_LIMIT",
      });

      const body = await response.json();

      expect(body.error).toBe("CUSTOM_LIMIT");
      expect(body.message).toBe("Custom message");
    });
  });

  describe("toOAuthSlowDownResponse", () => {
    it("returns an OAuth slow_down response with defaults", async () => {
      const response = toOAuthSlowDownResponse(
        createDecision({ degraded: true }),
      );
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(response.headers.get("Content-Type")).toBe("application/json");
      expect(response.headers.get("Retry-After")).not.toBeNull();
      expect(body).toMatchObject({
        error: "slow_down",
        error_description:
          "Polling too frequently. Please wait before trying again.",
        degraded: true,
      });
      expect(body.retry_after).toBeGreaterThanOrEqual(1);
    });

    it("honors custom OAuth description", async () => {
      const response = toOAuthSlowDownResponse(createDecision(), {
        message: "Poll less frequently",
      });
      const body = await response.json();

      expect(body.error_description).toBe("Poll less frequently");
    });
  });
});
