import { describe, expect, it } from "bun:test";

import {
  type BucketConfig,
  type ConsumeBucketOptions,
  type EffectiveQuotaMeta,
  type EnforceOptions,
  RateEngine,
  type RateEngineContext,
  type RateEngineOptions,
  type RateEngineRedisClient,
  type RateLimitDecision,
  type RateLimitPolicy,
  type RateLimitStageDecision,
  getRateLimitHeaders,
  toOAuthSlowDownResponse,
  toRateLimitResponse,
} from "../index";

describe("public exports", () => {
  it("exposes runtime exports from the package entrypoint", () => {
    expect(RateEngine).toBeFunction();
    expect(getRateLimitHeaders).toBeFunction();
    expect(toRateLimitResponse).toBeFunction();
    expect(toOAuthSlowDownResponse).toBeFunction();
  });

  it("exposes public types from the package entrypoint", () => {
    type PolicyId = "policy";
    type BucketId = "bucket";
    type Context = RateEngineContext & { id: string };

    const bucket = {
      requests: 1,
      window: "1 m",
    } satisfies BucketConfig;

    const policy = {
      failureMode: "open",
      stages: [
        {
          bucketId: "bucket",
          identifier: (context: Context) => context.id,
          tier: "single",
        },
      ],
    } satisfies RateLimitPolicy<BucketId, Context>;

    const redis = {} as RateEngineRedisClient;
    const options = {
      redis,
      buckets: { bucket },
      policies: { policy },
      analytics: false,
    } satisfies RateEngineOptions<PolicyId, BucketId, Context>;

    const consumeOptions = {
      failureMode: "closed",
    } satisfies ConsumeBucketOptions<PolicyId>;

    const enforceOptions = {
      waitUntil: (_promise: Promise<unknown>) => undefined,
    } satisfies EnforceOptions;

    const stageDecision = {
      allowed: true,
      bucketId: "bucket",
      identifier: "user-1",
      limit: 1,
      remaining: 1,
      used: 0,
      reset: Date.now(),
      resetDate: new Date(),
      degraded: false,
      tier: "single",
    } satisfies RateLimitStageDecision<PolicyId, BucketId>;

    const effective = {
      composite: false,
      limitSourceBucketId: "bucket",
      remainingSourceBucketId: "bucket",
      resetSourceBucketId: "bucket",
    } satisfies EffectiveQuotaMeta<BucketId>;

    const decision = {
      ...stageDecision,
      effective,
    } satisfies RateLimitDecision<PolicyId, BucketId>;

    expect(options.buckets.bucket.requests).toBe(1);
    expect(options.analytics).toBe(false);
    expect(consumeOptions.failureMode).toBe("closed");
    expect(enforceOptions.waitUntil).toBeFunction();
    expect(decision.effective.composite).toBe(false);
  });
});
