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
 * The final decision object returned by rate limiting evaluations.
 */
export type RateLimitDecision<
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
