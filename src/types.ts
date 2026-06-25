/**
 * Represents the cause of a rate limit evaluation failure or block.
 */
export type RateLimitFailureReason =
  | "denyList"
  | "cacheBlock"
  | "timeout"
  | "error";

/**
 * Categorization level of the rate limit stage.
 */
export type RateLimitTier = "single" | "global" | "category" | "endpoint";

/**
 * Snapshot of a bucket's rate limit state for a specific identifier.
 */
export type RateLimitSnapshot<TBucketId extends string = string> = {
  /** The unique ID of the rate limit bucket. */
  bucketId: TBucketId;
  /** The actor identifier (e.g. user ID, IP). */
  identifier: string;
  /** Maximum number of requests allowed in the window. */
  limit: number;
  /** Remaining requests allowed in the current window. */
  remaining: number;
  /** Number of tokens already used in the window. */
  used: number;
  /** Unix timestamp in ms when the rate limit window resets. */
  reset: number;
  /** Date object representation of the reset timestamp. */
  resetDate: Date;
  /** The reason for block/failure, if any. */
  reason?: RateLimitFailureReason;
  /** Indicates if the rate limiter is operating in fallback/degraded mode. */
  degraded: boolean;
};

/**
 * Metadata explaining the components of an effective composite rate limit decision.
 */
export type EffectiveQuotaMeta<TBucketId extends string = string> = {
  /** Indicates if the final decision metrics are a composite of multiple stages. */
  composite: boolean;
  /** The bucket ID that determined the limit. */
  limitSourceBucketId: TBucketId;
  /** The bucket ID that determined the remaining count. */
  remainingSourceBucketId: TBucketId;
  /** The bucket ID that determined the reset cooldown timer. */
  resetSourceBucketId: TBucketId;
};

/**
 * A snapshot representing a single rate limit check outcome.
 */
export type RateLimitStageDecision<
  TPolicyId extends string = string,
  TBucketId extends string = string,
> = RateLimitSnapshot<TBucketId> & {
  /** True if the request is permitted; false if rate-limited. */
  allowed: boolean;
  /** The ID of the policy being evaluated, if applicable. */
  policyId?: TPolicyId;
  /** The checking tier of this specific rate limit decision. */
  tier: RateLimitTier;
  /** Custom user-facing message associated with the block. */
  message?: string;
};

/**
 * The final decision object returned by rate limiting evaluations.
 */
export type RateLimitDecision<
  TPolicyId extends string = string,
  TBucketId extends string = string,
> = RateLimitStageDecision<TPolicyId, TBucketId> & {
  /** Snapshots of individual stages evaluated in a multi-stage check. */
  stages?: RateLimitStageDecision<TPolicyId, TBucketId>[];
  /** Metadata explaining composite quota metrics, if applicable. */
  effective?: EffectiveQuotaMeta<TBucketId>;
};

/**
 * Minimal duck-typed interface of a Redis client required by RateEngine.
 */
export type RateEngineRedisClient = {
  eval: (
    script: string,
    keys: string[],
    args: Array<string | number>,
  ) => Promise<unknown>;
  evalsha: (
    sha1: string,
    keys: string[],
    args: Array<string | number>,
  ) => Promise<unknown>;
  incr: (key: string) => Promise<number>;
  expire: (key: string, seconds: number) => Promise<number | boolean>;
  ping: () => Promise<unknown>;
};

/**
 * Standard logger logging structure used by the rate limiter engine.
 */
export type RateEngineLogger = {
  info?: (message: string, meta?: Record<string, unknown>) => void;
  warn?: (message: string, meta?: Record<string, unknown>) => void;
  error?: (message: string, meta?: Record<string, unknown>) => void;
};

/**
 * Algorithms supported by @upstash/ratelimit.
 */
export type RateLimitAlgorithm =
  | "slidingWindow"
  | "fixedWindow"
  | "tokenBucket";

/**
 * Definition structure for a rate limiting bucket capacity and window.
 */
export type BucketConfig<TDuration extends string = string> = {
  /** Max requests permitted inside the rate limit window. */
  requests: number;
  /** Window size string (e.g. "10 s", "1 m", "24 h"). */
  window: TDuration;
  /** Rate limiter algorithm. Defaults to "slidingWindow". */
  algorithm?: RateLimitAlgorithm;
  /** Optional refill rate (only applicable to tokenBucket). */
  refillRate?: number;
  /** Optional description explaining the bucket's usage. */
  description?: string;
};

/**
 * Represents a single stage inside a multi-stage rate limit policy.
 */
export type RateLimitPolicyStage<TBucketId extends string, TContext> = {
  /** Bucket ID or a function resolving a dynamic Bucket ID from context. */
  bucketId: TBucketId | ((context: TContext) => TBucketId);
  /** Resolver function to extract the unique actor identifier from context. */
  identifier: (context: TContext) => string | undefined;
  /** The evaluation tier associated with this stage. */
  tier: RateLimitTier;
  /** Custom response override message if this stage blocks. */
  message?: string;
};

/**
 * A multi-stage rate limiting pipeline policy definition.
 */
export type RateLimitPolicy<TBucketId extends string, TContext> = {
  /** Defines if requests should be blocked ("closed") or allowed ("open") on Redis error. */
  failureMode: "open" | "closed";
  /** Ordered stages sequentially evaluated during enforcement. */
  stages: RateLimitPolicyStage<TBucketId, TContext>[];
};

/**
 * Context payload containing request metadata.
 */
export type RateEngineContext = {
  ipAddress?: string;
  userAgent?: string;
  country?: string;
  [key: string]: unknown;
};

/**
 * Options passed to manual bucket consumption calls.
 */
export type ConsumeBucketOptions<TPolicyId extends string> = {
  /** Optional custom token cost to consume for this request. Defaults to 1. */
  rate?: number;
  /** Metadata parameters passed to Upstash analytics uploads. */
  context?: {
    ip?: string;
    userAgent?: string;
    country?: string;
  };
  /** The evaluation tier categorization level. Defaults to "single". */
  tier?: RateLimitTier;
  /** The ID of the policy triggering this bucket consume, if applicable. */
  policyId?: TPolicyId;
  /** Override error message if this consume blocks. */
  message?: string;
  /** Defines whether direct consumption should allow (fail-open) or block (fail-closed) on Redis connection error. Defaults to "open". */
  failureMode?: "open" | "closed";
};

/**
 * Options passed to policy enforcement calls.
 */
export type EnforceOptions = {
  /** Wait-until context method used to keep background analytics upload promises alive in serverless/edge environments. */
  waitUntil?: (promise: Promise<unknown>) => void;
};

/**
 * Options to instantiate a RateEngine instance.
 */
export type RateEngineOptions<
  TPolicyId extends string,
  TBucketId extends string,
  TContext extends RateEngineContext,
> = {
  /** A duck-typed Redis client instance. Compatible with @upstash/redis or ioredis. */
  redis: RateEngineRedisClient;
  /** Configuration defining the limits and window durations for all buckets. */
  buckets: Record<TBucketId, BucketConfig>;
  /** Configuration mapping policy IDs to their cascaded checking stages. */
  policies: Record<TPolicyId, RateLimitPolicy<TBucketId, TContext>>;
  /** Logging interface to report background metrics errors or health pings. Defaults to no-op. */
  logger?: RateEngineLogger;
  /** Redis execution timeout in milliseconds. Defaults to 1000ms. */
  redisTimeoutMs?: number;
  /** Fake reset delay in ms applied to fallback snapshots if Redis goes offline. Defaults to 60000ms. */
  fallbackResetMs?: number;
  /** Enables @upstash/ratelimit analytics uploads. Defaults to true. */
  analytics?: boolean;
  /** Optional per-bucket Redis key prefix overrides. */
  bucketPrefixOverrides?: Partial<Record<TBucketId, string>>;
  /** Dynamic policy hook to swap out policies at runtime (e.g., swapping to strict checkout limits). */
  resolvePolicy?: (
    policyId: TPolicyId,
    context: TContext,
  ) => Promise<TPolicyId> | TPolicyId;
  /** Shared cache Map to cache tokens locally and bypass Redis connection overhead. */
  ephemeralCache?: Map<string, number>;
  /** Telemetry callback invoked when a rate limit is violated or if a fail-closed policy fails during degradation. */
  onViolation?: (
    context: TContext,
    decision: RateLimitDecision<TPolicyId, TBucketId>,
  ) => Promise<void> | void;
};
