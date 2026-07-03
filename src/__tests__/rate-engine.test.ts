import { describe, expect, it, mock } from "bun:test";

import type {
  BucketConfig,
  RateEngineOptions,
  RateEngineRedisClient,
  RateLimitPolicy,
} from "../types";

import { RateEngine } from "../rate-engine";
import {
  createFailingRedisMock,
  createLimitResult,
  createLoggerMock,
  createMockedEngine,
  createRedisMock,
  defaultBuckets,
  defaultPolicies,
  type TestBucketId,
  type TestContext,
  type TestPolicyId,
} from "./test-utils";

describe("RateEngine", () => {
  describe("consumeBucket", () => {
    it("returns a normalized successful decision", async () => {
      const reset = Date.now() + 30_000;
      const { engine, limiter } = createMockedEngine();
      limiter.limit.mockResolvedValueOnce(
        createLimitResult({
          success: true,
          limit: 10,
          remaining: 7,
          reset,
          reason: "cacheBlock",
        }),
      );

      const decision = await engine.consumeBucket("bucketA", "user-1", {
        tier: "endpoint",
        policyId: "basic",
        message: "Slow down",
      });

      expect(decision).toMatchObject({
        allowed: true,
        bucketId: "bucketA",
        identifier: "user-1",
        limit: 10,
        remaining: 7,
        used: 3,
        reset,
        reason: "cacheBlock",
        tier: "endpoint",
        policyId: "basic",
        message: "Slow down",
        degraded: false,
      });
      expect(decision.resetDate).toEqual(new Date(reset));
    });

    it("passes rate and analytics context to the limiter", async () => {
      const { engine, limiter } = createMockedEngine();

      await engine.consumeBucket("bucketA", "user-1", {
        rate: 3,
        context: {
          ip: "203.0.113.10",
          userAgent: "test-agent",
          country: "US",
        },
      });

      expect(limiter.limit).toHaveBeenCalledWith("user-1", {
        rate: 3,
        ip: "203.0.113.10",
        userAgent: "test-agent",
        country: "US",
      });
    });

    it("defaults to fail-open behavior on Redis errors", async () => {
      const { engine, limiter } = createMockedEngine();
      limiter.limit.mockRejectedValueOnce(new Error("Redis offline"));

      const decision = await engine.consumeBucket("bucketA", "user-1");

      expect(decision.allowed).toBe(true);
      expect(decision.degraded).toBe(true);
      expect(decision.reason).toBe("error");
      expect(decision.limit).toBe(10);
      expect(decision.remaining).toBe(10);
    });

    it("respects fail-closed mode and custom fallback messages", async () => {
      const { engine, limiter } = createMockedEngine();
      limiter.limit.mockRejectedValueOnce(new Error("Redis offline"));

      const decision = await engine.consumeBucket("bucketA", "user-1", {
        failureMode: "closed",
        message: "Custom fallback",
      });

      expect(decision.allowed).toBe(false);
      expect(decision.degraded).toBe(true);
      expect(decision.message).toBe("Custom fallback");
    });

    it("uses configured bucket capacity and fallbackResetMs in fallback snapshots", async () => {
      const fallbackResetMs = 12_000;
      const before = Date.now();
      const { engine, limiter } = createMockedEngine({ fallbackResetMs });
      limiter.limit.mockRejectedValueOnce(new Error("Redis offline"));

      const decision = await engine.consumeBucket("bucketB", "user-1");

      expect(decision.limit).toBe(5);
      expect(decision.remaining).toBe(5);
      expect(decision.reset).toBeGreaterThanOrEqual(before + fallbackResetMs);
      expect(decision.reset).toBeLessThanOrEqual(Date.now() + fallbackResetMs);
    });

    it("passes pending analytics promises to waitUntil when provided", async () => {
      const pending = Promise.resolve("done");
      const waitUntil = mock(() => undefined);
      const { engine, limiter } = createMockedEngine();
      limiter.limit.mockResolvedValueOnce(createLimitResult({ pending }));

      await engine.consumeBucket("bucketA", "user-1", undefined, { waitUntil });

      expect(waitUntil).toHaveBeenCalledWith(pending);
    });

    it("logs rejected pending analytics promises when waitUntil is absent", async () => {
      const logger = createLoggerMock();
      const pending = Promise.reject(new Error("analytics failed"));
      const { engine, limiter } = createMockedEngine({ logger });
      limiter.limit.mockResolvedValueOnce(createLimitResult({ pending }));

      await engine.consumeBucket("bucketA", "user-1");
      await pending.catch(() => undefined);

      expect(logger.error).toHaveBeenCalledWith(
        "[RateEngine] Background analytics upload failed",
        {
          bucketId: "bucketA",
          error: expect.any(Error),
        },
      );
    });

    it("throws when bucket configuration is missing", async () => {
      const redis = createRedisMock();
      const engine = new RateEngine<TestPolicyId, TestBucketId, TestContext>({
        redis,
        buckets: { bucketA: defaultBuckets.bucketA } as unknown as Record<
          TestBucketId,
          BucketConfig
        >,
        policies: {},
      });

      await expect(engine.consumeBucket("bucketB", "user-1")).rejects.toThrow(
        "[RateEngine] Missing configuration for bucket: bucketB",
      );
    });

    it("trims identifiers and rejects empty or oversized values", async () => {
      const { engine, limiter } = createMockedEngine();

      await engine.consumeBucket("bucketA", "  user-1  ");
      expect(limiter.limit).toHaveBeenCalledWith("user-1", expect.any(Object));

      await expect(engine.consumeBucket("bucketA", "   ")).rejects.toThrow(
        "[RateEngine] Identifier is empty or whitespace-only",
      );
      await expect(
        engine.consumeBucket("bucketA", "ü".repeat(257)),
      ).rejects.toThrow("[RateEngine] Identifier exceeds 512 bytes");
    });

    it("rejects invalid token costs before calling the limiter", async () => {
      const { engine, limiter } = createMockedEngine();

      for (const rate of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
        await expect(
          engine.consumeBucket("bucketA", "user-1", { rate }),
        ).rejects.toThrow("[RateEngine] Rate must be a positive safe integer");
      }
      expect(limiter.limit).not.toHaveBeenCalled();
    });
  });

  describe("real limiter construction", () => {
    function createRealEngine(options: {
      buckets: Record<TestBucketId, BucketConfig>;
      redis?: RateEngineRedisClient;
      analytics?: boolean;
    }) {
      return new RateEngine<TestPolicyId, TestBucketId, TestContext>({
        redis: options.redis ?? createFailingRedisMock(),
        buckets: options.buckets,
        policies: {
          basic: {
            stages: [
              {
                bucketId: "bucketA",
                identifier: (ctx) => ctx.id,
                tier: "single",
              },
            ],
            failureMode: "open",
          },
        },
        analytics: options.analytics,
      });
    }

    it.each([
      ["slidingWindow", { requests: 10, window: "60 s" }],
      [
        "fixedWindow",
        { requests: 10, window: "60 s", algorithm: "fixedWindow" },
      ],
      [
        "tokenBucket",
        {
          requests: 10,
          window: "60 s",
          algorithm: "tokenBucket",
          refillRate: 2,
        },
      ],
    ] as const)(
      "constructs a real %s limiter and falls back when Redis fails",
      async (_algorithm, bucketConfig) => {
        const engine = createRealEngine({
          buckets: {
            bucketA: bucketConfig,
            bucketB: defaultBuckets.bucketB,
            bucketC: defaultBuckets.bucketC,
          } as Record<TestBucketId, BucketConfig>,
        });

        const decision = await engine.consumeBucket("bucketA", "user-1");

        expect(decision.allowed).toBe(true);
        expect(decision.degraded).toBe(true);
        expect(decision.reason).toBe("error");
      },
    );

    it("reuses cached limiter instances for repeated bucket consumes", async () => {
      const engine = createRealEngine({
        buckets: {
          bucketA: defaultBuckets.bucketA,
          bucketB: defaultBuckets.bucketB,
          bucketC: defaultBuckets.bucketC,
        },
      });
      const cache = (
        engine as unknown as { limiterCache: Map<string, unknown> }
      ).limiterCache;

      await engine.consumeBucket("bucketA", "user-1");
      await engine.consumeBucket("bucketA", "user-2");

      expect(cache.size).toBe(1);
      expect(cache.has("bucketA")).toBe(true);
    });

    it("enables Upstash analytics by default and allows opting out", async () => {
      const enabledEngine = createRealEngine({
        buckets: defaultBuckets,
      });
      await enabledEngine.consumeBucket("bucketA", "user-1");
      const enabledLimiter = (
        enabledEngine as unknown as { limiterCache: Map<string, unknown> }
      ).limiterCache.get("bucketA") as { analytics?: unknown };

      const disabledEngine = createRealEngine({
        buckets: defaultBuckets,
        analytics: false,
      });
      await disabledEngine.consumeBucket("bucketA", "user-1");
      const disabledLimiter = (
        disabledEngine as unknown as { limiterCache: Map<string, unknown> }
      ).limiterCache.get("bucketA") as { analytics?: unknown };

      expect(enabledLimiter.analytics).toBeDefined();
      expect(disabledLimiter.analytics).toBeUndefined();
    });
  });

  describe("readBucket and resetBucket", () => {
    it("reads remaining tokens without consuming", async () => {
      const reset = Date.now() + 45_000;
      const { engine, limiter } = createMockedEngine();
      limiter.getRemaining.mockResolvedValueOnce({
        limit: 10,
        remaining: 4,
        reset,
      });

      const snapshot = await engine.readBucket("bucketA", "user-1");

      expect(snapshot).toMatchObject({
        bucketId: "bucketA",
        identifier: "user-1",
        limit: 10,
        remaining: 4,
        used: 6,
        reset,
        degraded: false,
      });
      expect(snapshot.resetDate).toEqual(new Date(reset));
      expect(limiter.limit).not.toHaveBeenCalled();
      expect(limiter.getRemaining).toHaveBeenCalledWith("user-1");
    });

    it("returns fallback and records failure when readBucket fails", async () => {
      const logger = createLoggerMock();
      const { engine, limiter } = createMockedEngine({ logger });
      limiter.getRemaining.mockRejectedValueOnce(new Error("read failed"));

      const snapshot = await engine.readBucket("bucketA", "user-1");
      const metrics = engine.getInstanceMetrics();

      expect(snapshot.degraded).toBe(true);
      expect(snapshot.reason).toBe("error");
      expect(logger.error).toHaveBeenCalledWith(
        "[RateEngine] Bucket read failed",
        expect.objectContaining({
          bucketId: "bucketA",
          error: expect.any(Error),
        }),
      );
      expect(metrics.totalFailures).toBe(1);
    });

    it("resets a bucket and records success", async () => {
      const { engine, limiter } = createMockedEngine();

      const result = await engine.resetBucket("bucketA", "user-1");
      const metrics = engine.getInstanceMetrics();

      expect(result).toEqual({ ok: true });
      expect(limiter.resetUsedTokens).toHaveBeenCalledWith("user-1");
      expect(metrics.lastSuccess).not.toBeNull();
    });

    it("returns an explicit failure when resetBucket cannot reach Redis", async () => {
      const logger = createLoggerMock();
      const { engine, limiter } = createMockedEngine({ logger });
      limiter.resetUsedTokens.mockRejectedValueOnce(new Error("reset failed"));

      const result = await engine.resetBucket("bucketA", "user-1");
      const metrics = engine.getInstanceMetrics();

      expect(result).toEqual({ ok: false, reason: "backend_error" });
      expect(logger.error).toHaveBeenCalledWith(
        "[RateEngine] Failed to reset bucket",
        expect.objectContaining({
          bucketId: "bucketA",
          error: expect.any(Error),
        }),
      );
      expect(metrics.totalFailures).toBe(1);
    });

    it("reads multiple buckets concurrently in input order", async () => {
      const { engine, limiter } = createMockedEngine();
      limiter.getRemaining
        .mockResolvedValueOnce({
          limit: 10,
          remaining: 7,
          reset: Date.now() + 10_000,
        })
        .mockResolvedValueOnce({
          limit: 5,
          remaining: 2,
          reset: Date.now() + 20_000,
        });

      const snapshots = await engine.readBuckets([
        { bucketId: "bucketA", identifier: "user-1" },
        { bucketId: "bucketB", identifier: "user-1" },
      ]);

      expect(snapshots.map(({ bucketId }) => bucketId)).toEqual([
        "bucketA",
        "bucketB",
      ]);
      expect(limiter.getRemaining).toHaveBeenCalledTimes(2);
    });
  });

  describe("enforce", () => {
    it("throws for undefined policies and missing identifiers", async () => {
      const { engine } = createMockedEngine({
        policies: {
          missingIdentifier: {
            stages: [
              {
                bucketId: "bucketA",
                identifier: () => undefined,
                tier: "single",
              },
            ],
            failureMode: "open",
          },
        },
      });

      await expect(engine.enforce("nonexistent", { id: "1" })).rejects.toThrow(
        "[RateEngine] Policy resolution returned an unknown policy",
      );
      await expect(engine.enforce("missingIdentifier", {})).rejects.toThrow(
        "[RateEngine] Missing identifier for policy=missingIdentifier bucket=bucketA",
      );
    });

    it("uses resolved policy before lookup and failure-mode selection", async () => {
      const { engine, limiter } = createMockedEngine({
        resolvePolicy: () => "resolved",
        policies: {
          dynamic: {
            stages: [
              {
                bucketId: "bucketA",
                identifier: (ctx) => ctx.id,
                tier: "single",
              },
            ],
            failureMode: "open",
          },
          resolved: {
            stages: [
              {
                bucketId: "bucketB",
                identifier: (ctx) => ctx.id,
                tier: "endpoint",
              },
            ],
            failureMode: "closed",
          },
        },
      });
      limiter.limit.mockRejectedValueOnce(new Error("Redis offline"));

      const decision = await engine.enforce("dynamic", { id: "user-1" });

      expect(decision.allowed).toBe(false);
      expect(decision.policyId).toBe("resolved");
      expect(decision.bucketId).toBe("bucketB");
      expect(decision.stages).toBeArrayOfSize(1);
    });

    it("does not expose an unknown resolved policy ID", async () => {
      const { engine } = createMockedEngine({
        resolvePolicy: () => "internal-policy-name",
      });

      await expect(engine.enforce("basic", { id: "user-1" })).rejects.toThrow(
        "[RateEngine] Policy resolution returned an unknown policy",
      );
    });

    it("supports dynamic bucket IDs from context", async () => {
      const { engine } = createMockedEngine({
        policies: {
          dynamicBucket: {
            stages: [
              {
                bucketId: (ctx) => ctx.bucketChoice ?? "bucketA",
                identifier: (ctx) => ctx.id,
                tier: "single",
              },
            ],
            failureMode: "open",
          },
        },
      });

      const decision = await engine.enforce("dynamicBucket", {
        id: "user-1",
        bucketChoice: "bucketB",
      });

      expect(decision.bucketId).toBe("bucketB");
    });

    it("short-circuits on blocked stages and includes evaluated stages", async () => {
      const onViolation = mock(() => undefined);
      const { engine, limiter } = createMockedEngine({
        policies: {
          blocked: {
            stages: [
              {
                bucketId: "bucketA",
                identifier: (ctx) => ctx.id,
                tier: "global",
              },
              {
                bucketId: "bucketB",
                identifier: (ctx) => ctx.id,
                tier: "endpoint",
              },
            ],
            failureMode: "open",
          },
        },
      });
      (
        engine as unknown as { options: { onViolation: typeof onViolation } }
      ).options.onViolation = onViolation;
      limiter.limit.mockResolvedValueOnce(
        createLimitResult({ success: false, remaining: 0 }),
      );

      const decision = await engine.enforce("blocked", { id: "user-1" });

      expect(decision.allowed).toBe(false);
      expect(decision.stages).toBeArrayOfSize(1);
      expect(limiter.limit).toHaveBeenCalledTimes(1);
      expect(onViolation).toHaveBeenCalledWith(
        { id: "user-1" },
        expect.objectContaining({
          allowed: false,
          stages: expect.any(Array),
        }),
      );
    });

    it("returns the blocked decision when the violation hook fails", async () => {
      const logger = createLoggerMock();
      const { engine, limiter } = createMockedEngine({
        logger,
        policies: {
          blocked: {
            stages: [
              {
                bucketId: "bucketA",
                identifier: (ctx) => ctx.id,
                tier: "single",
              },
            ],
            failureMode: "open",
          },
        },
      });
      (
        engine as unknown as {
          options: { onViolation: () => Promise<void> };
        }
      ).options.onViolation = async () => {
        throw new Error("telemetry unavailable");
      };
      limiter.limit.mockResolvedValueOnce(
        createLimitResult({ success: false, remaining: 0 }),
      );

      const decision = await engine.enforce("blocked", { id: "user-1" });

      expect(decision.allowed).toBe(false);
      expect(logger.error).toHaveBeenCalledWith(
        "[RateEngine] Violation callback failed",
        { error: expect.any(Error) },
      );
    });

    it("blocks fail-closed degradation and allows fail-open degradation", async () => {
      const closed = createMockedEngine({
        policies: {
          closed: {
            stages: [
              {
                bucketId: "bucketA",
                identifier: (ctx) => ctx.id,
                tier: "single",
              },
            ],
            failureMode: "closed",
          },
        },
      });
      closed.limiter.limit.mockRejectedValueOnce(new Error("Redis offline"));

      const closedDecision = await closed.engine.enforce("closed", {
        id: "user-1",
      });

      expect(closedDecision.allowed).toBe(false);
      expect(closedDecision.degraded).toBe(true);
      expect(closedDecision.stages).toBeArrayOfSize(1);

      const open = createMockedEngine({
        policies: {
          open: {
            stages: [
              {
                bucketId: "bucketA",
                identifier: (ctx) => ctx.id,
                tier: "single",
              },
            ],
            failureMode: "open",
          },
        },
      });
      open.limiter.limit.mockRejectedValueOnce(new Error("Redis offline"));

      const openDecision = await open.engine.enforce("open", { id: "user-1" });

      expect(openDecision.allowed).toBe(true);
      expect(openDecision.degraded).toBe(true);
    });

    it("returns composite effective quota metadata for multi-stage allowed decisions", async () => {
      const { engine, limiter } = createMockedEngine({
        policies: {
          multi: {
            stages: [
              {
                bucketId: "bucketA",
                identifier: (ctx) => ctx.id,
                tier: "global",
              },
              {
                bucketId: "bucketB",
                identifier: (ctx) => ctx.id,
                tier: "endpoint",
              },
            ],
            failureMode: "open",
          },
        },
      });
      limiter.limit
        .mockResolvedValueOnce(
          createLimitResult({
            success: true,
            limit: 10,
            remaining: 2,
            reset: Date.now() + 5_000,
          }),
        )
        .mockResolvedValueOnce(
          createLimitResult({
            success: true,
            limit: 100,
            remaining: 9,
            reset: Date.now() + 20_000,
          }),
        );

      const decision = await engine.enforce("multi", { id: "user-1" });

      expect(decision.allowed).toBe(true);
      expect(decision.limit).toBe(10);
      expect(decision.remaining).toBe(2);
      expect(decision.reset).toBeGreaterThan(Date.now() + 15_000);
      expect(decision.effective).toEqual({
        composite: true,
        limitSourceBucketId: "bucketA",
        remainingSourceBucketId: "bucketA",
        resetSourceBucketId: "bucketB",
      });
      expect(decision.stages).toBeArrayOfSize(2);
    });

    it("returns non-composite effective metadata when one stage supplies all root quota fields", async () => {
      const { engine, limiter } = createMockedEngine();
      limiter.limit.mockResolvedValueOnce(
        createLimitResult({
          success: true,
          limit: 10,
          remaining: 8,
          reset: Date.now() + 10_000,
        }),
      );

      const decision = await engine.enforce("basic", { id: "user-1" });

      expect(decision.effective).toEqual({
        composite: false,
        limitSourceBucketId: "bucketA",
        remainingSourceBucketId: "bucketA",
        resetSourceBucketId: "bucketA",
      });
    });

    it("resolves failure mode from explicit policy settings", () => {
      const engine = createMockedEngine({
        policies: {
          explicitOpen: {
            stages: defaultPolicies.basic!.stages,
            failureMode: "open",
          },
          explicitClosed: {
            stages: defaultPolicies.basic!.stages,
            failureMode: "closed",
          },
        },
      }).engine;
      expect(engine.getFailureMode("explicitClosed")).toBe("closed");
      expect(engine.getFailureMode("explicitOpen")).toBe("open");
      expect(() => engine.getFailureMode("unknown")).toThrow(
        "[RateEngine] Undefined policy: unknown",
      );
    });
  });

  describe("configuration validation", () => {
    it("rejects invalid buckets, policies, and timing options at construction", () => {
      const create =
        (
          overrides: Partial<
            RateEngineOptions<TestPolicyId, TestBucketId, TestContext>
          >,
        ) =>
        () =>
          new RateEngine<TestPolicyId, TestBucketId, TestContext>({
            redis: createRedisMock(),
            buckets: defaultBuckets,
            policies: defaultPolicies as Record<
              TestPolicyId,
              RateLimitPolicy<TestBucketId, TestContext>
            >,
            ...overrides,
          });

      expect(create({ redisTimeoutMs: 0 })).toThrow(
        "redisTimeoutMs must be a positive safe integer",
      );
      expect(
        create({
          buckets: {
            ...defaultBuckets,
            bucketA: { requests: 0, window: "1 m" },
          },
        }),
      ).toThrow('Bucket "bucketA" requests must be a positive safe integer');
      expect(
        create({
          buckets: {
            ...defaultBuckets,
            bucketA: {
              requests: 1,
              window: " ",
            } as unknown as BucketConfig,
          },
        }),
      ).toThrow('Bucket "bucketA" window must be a positive duration');
      expect(
        create({
          buckets: {
            ...defaultBuckets,
            bucketA: {
              requests: 1,
              window: "tomorrow",
            } as unknown as BucketConfig,
          },
        }),
      ).toThrow('Bucket "bucketA" window must be a positive duration');
      expect(
        create({
          buckets: {
            ...defaultBuckets,
            bucketA: {
              requests: 1,
              window: "1 m",
              refillRate: 1,
            },
          },
        }),
      ).toThrow('Bucket "bucketA" refillRate requires tokenBucket');
      expect(
        create({
          policies: {
            empty: { stages: [], failureMode: "open" },
          },
        }),
      ).toThrow("Policy has no stages defined: empty");
      expect(
        create({
          policies: {
            invalid: {
              failureMode: "open",
              stages: [
                {
                  bucketId: "missing" as TestBucketId,
                  identifier: (context) => context.id,
                  tier: "single",
                },
              ],
            },
          },
        }),
      ).toThrow('Policy "invalid" references unknown bucket: missing');
    });
  });

  describe("health telemetry", () => {
    it("tracks success, failures, recovery and reset", async () => {
      const redis = createRedisMock();
      const { engine } = createMockedEngine({ redis });

      const healthy = await engine.pingRedis();
      expect(healthy.reachable).toBe(true);
      expect(healthy.latencyMs).toBeGreaterThanOrEqual(0);
      expect(engine.getInstanceMetrics().lastSuccess).not.toBeNull();

      (redis.ping as ReturnType<typeof mock>)
        .mockRejectedValueOnce(new Error("failure 1"))
        .mockRejectedValueOnce(new Error("failure 2"))
        .mockResolvedValueOnce("PONG");

      const failed1 = await engine.pingRedis();
      expect(failed1.reachable).toBe(false);
      expect(engine.getInstanceMetrics().consecutiveFailures).toBe(1);

      const failed2 = await engine.pingRedis();
      expect(failed2.reachable).toBe(false);
      expect(engine.getInstanceMetrics().consecutiveFailures).toBe(2);

      const recovered = await engine.pingRedis();
      const recoveredMetrics = engine.getInstanceMetrics();
      expect(recovered.reachable).toBe(true);
      expect(recoveredMetrics.consecutiveFailures).toBe(0);
      expect(recoveredMetrics.totalFailures).toBe(2);
      expect(recoveredMetrics.lastFailure).not.toBeNull();

      engine.resetHealth();
      const reset = engine.getInstanceMetrics();
      expect(reset.totalFailures).toBe(0);
      expect(reset.consecutiveFailures).toBe(0);
      expect(reset.lastFailure).toBeNull();
      expect(reset.lastSuccess).toBeNull();
    });
  });
});
