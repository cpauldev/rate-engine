import { mock } from "bun:test";

import { RateEngine } from "../rate-engine";
import type {
  BucketConfig,
  RateEngineContext,
  RateEngineLogger,
  RateEngineOptions,
  RateEngineRedisClient,
  RateLimitDecision,
  RateLimitFailureReason,
  RateLimitPolicy,
  RateLimitSnapshot,
} from "../types";

export type TestPolicyId = string;
export type TestBucketId = "bucketA" | "bucketB" | "bucketC";
export type TestContext = RateEngineContext & {
  id?: string;
  bucketChoice?: TestBucketId;
};

export type LimitResult = Omit<
  RateLimitSnapshot<TestBucketId>,
  "bucketId" | "identifier" | "used" | "degraded" | "resetDate"
> & {
  success: boolean;
  pending?: Promise<unknown>;
};

export type RemainingResult = Pick<
  LimitResult,
  "limit" | "remaining" | "reset"
>;

export type TestLimiter = {
  limit: ReturnType<
    typeof mock<
      (
        identifier: string,
        options?: {
          rate?: number;
          ip?: string;
          userAgent?: string;
          country?: string;
        },
      ) => Promise<LimitResult>
    >
  >;
  getRemaining: ReturnType<
    typeof mock<(identifier: string) => Promise<RemainingResult>>
  >;
  resetUsedTokens: ReturnType<
    typeof mock<(identifier: string) => Promise<void>>
  >;
};

export type TestEngine = RateEngine<TestPolicyId, TestBucketId, TestContext>;

export function createLimitResult(
  overrides: Partial<LimitResult> = {},
): LimitResult {
  return {
    success: true,
    limit: 10,
    remaining: 9,
    reset: Date.now() + 60_000,
    reason: undefined as RateLimitFailureReason | undefined,
    pending: undefined,
    ...overrides,
  };
}

export function createRedisMock(): RateEngineRedisClient {
  return {
    eval: mock(() => Promise.resolve([])),
    evalsha: mock(() => Promise.resolve([])),
    incr: mock(() => Promise.resolve(1)),
    expire: mock(() => Promise.resolve(1)),
    ping: mock(() => Promise.resolve("PONG")),
  };
}

export function createFailingRedisMock(): RateEngineRedisClient {
  return {
    eval: mock(() => Promise.reject(new Error("eval failed"))),
    evalsha: mock(() => Promise.reject(new Error("evalsha failed"))),
    incr: mock(() => Promise.resolve(1)),
    expire: mock(() => Promise.resolve(1)),
    ping: mock(() => Promise.resolve("PONG")),
  };
}

export function createLoggerMock(): Required<RateEngineLogger> {
  return {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
  };
}

export function createLimiterMock(
  overrides: Partial<TestLimiter> = {},
): TestLimiter {
  return {
    limit: mock(() => Promise.resolve(createLimitResult())),
    getRemaining: mock(() =>
      Promise.resolve({
        limit: 10,
        remaining: 9,
        reset: Date.now() + 60_000,
      }),
    ),
    resetUsedTokens: mock(() => Promise.resolve()),
    ...overrides,
  };
}

export const defaultBuckets = {
  bucketA: { requests: 10, window: "60 s" },
  bucketB: { requests: 5, window: "30 s" },
  bucketC: { requests: 2, window: "10 s", algorithm: "fixedWindow" },
} satisfies Record<TestBucketId, BucketConfig>;

export const defaultPolicies = {
  basic: {
    stages: [
      {
        bucketId: "bucketA",
        identifier: (ctx) => ctx.id,
        tier: "single",
        message: "Basic limit exceeded",
      },
    ],
    failureMode: "open",
  },
} satisfies Partial<
  Record<TestPolicyId, RateLimitPolicy<TestBucketId, TestContext>>
>;

export function createMockedEngine(
  options: {
    redis?: RateEngineRedisClient;
    logger?: RateEngineLogger;
    buckets?: Partial<Record<TestBucketId, BucketConfig>>;
    policies?: Partial<
      Record<TestPolicyId, RateLimitPolicy<TestBucketId, TestContext>>
    >;
    limiter?: TestLimiter;
    resolvePolicy?: (
      policyId: TestPolicyId,
      context: TestContext,
    ) => Promise<TestPolicyId> | TestPolicyId;
    fallbackResetMs?: number;
  } = {},
): {
  engine: TestEngine;
  limiter: TestLimiter;
  redis: RateEngineRedisClient;
} {
  const redis = options.redis ?? createRedisMock();
  const limiter = options.limiter ?? createLimiterMock();
  const engine = new RateEngine<TestPolicyId, TestBucketId, TestContext>({
    redis,
    logger: options.logger,
    buckets: {
      ...defaultBuckets,
      ...options.buckets,
    },
    policies: {
      ...defaultPolicies,
      ...options.policies,
    } as Record<TestPolicyId, RateLimitPolicy<TestBucketId, TestContext>>,
    resolvePolicy: options.resolvePolicy,
    fallbackResetMs: options.fallbackResetMs,
  } satisfies RateEngineOptions<TestPolicyId, TestBucketId, TestContext>);

  (engine as unknown as { getLimiter: () => TestLimiter }).getLimiter = () =>
    limiter;

  return { engine, limiter, redis };
}

export function createDecision(
  overrides: Partial<RateLimitDecision> = {},
): RateLimitDecision {
  return {
    allowed: false,
    bucketId: "bucketA",
    identifier: "user-1",
    limit: 10,
    remaining: 0,
    used: 10,
    reset: Date.now() + 60_000,
    resetDate: new Date(Date.now() + 60_000),
    degraded: false,
    tier: "single",
    ...overrides,
  };
}
