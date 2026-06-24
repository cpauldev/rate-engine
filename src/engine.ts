import { type Duration, Ratelimit } from "@upstash/ratelimit";

import type {
  BucketConfig,
  RateLimitDecision,
  RateLimitFailureReason,
  RateLimitPolicy,
  RateLimitSnapshot,
  RateLimitTier,
  RateEngineContext,
  RateEngineLogger,
  RateEngineRedisClient,
} from "./types";

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
  policies: Record<
    TPolicyId,
    | Omit<RateLimitPolicy<TBucketId, TContext>, "failureMode">
    | RateLimitPolicy<TBucketId, TContext>
  >;
  /** A set of policy IDs that must fail-closed (block the request) if the Redis backend is degraded. */
  closedFailurePolicies?: TPolicyId[] | Set<TPolicyId>;
  /** Logging interface to report background metrics errors or health pings. Defaults to no-op. */
  logger?: RateEngineLogger;
  /** Redis execution timeout in milliseconds. Defaults to 1000ms. */
  redisTimeoutMs?: number;
  /** Fake reset delay in ms applied to fallback snapshots if Redis goes offline. Defaults to 60000ms. */
  fallbackResetMs?: number;
  /** A prefix mapping overrides. Useful for matching legacy redis namespaces (e.g. { "auth": "legacy:auth" }). */
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
};

/**
 * Options passed to policy enforcement calls.
 */
export type EnforceOptions = {
  /** Wait-until context method used to keep background analytics upload promises alive in serverless/edge environments. */
  waitUntil?: (promise: Promise<unknown>) => void;
};

/**
 * High-performance, client-agnostic rate limiting engine for TypeScript.
 * Powered by `@upstash/ratelimit`, supporting cascading pipelines and fail-open/fail-closed protection.
 */
export class RateEngine<
  TPolicyId extends string,
  TBucketId extends string,
  TContext extends RateEngineContext,
> {
  private redis: RateEngineRedisClient;
  private logger: RateEngineLogger;
  private limiterCache = new Map<TBucketId, Ratelimit>();
  private defaultSharedCache = new Map<string, number>();
  private closedFailurePoliciesSet: Set<TPolicyId>;
  private redisTimeoutMs: number;
  private fallbackResetMs: number;

  /**
   * Initializes a new instance of the RateEngine engine.
   *
   * @param options Configuration options.
   */
  constructor(
    private options: RateEngineOptions<TPolicyId, TBucketId, TContext>,
  ) {
    this.redis = options.redis;
    this.logger = options.logger ?? {};
    this.redisTimeoutMs = options.redisTimeoutMs ?? 1000;
    this.fallbackResetMs = options.fallbackResetMs ?? 60000;

    if (options.closedFailurePolicies instanceof Set) {
      this.closedFailurePoliciesSet = options.closedFailurePolicies;
    } else if (Array.isArray(options.closedFailurePolicies)) {
      this.closedFailurePoliciesSet = new Set(options.closedFailurePolicies);
    } else {
      this.closedFailurePoliciesSet = new Set();
    }
  }

  /**
   * Generates the Redis key prefix for a given bucket ID.
   */
  private getBucketPrefix(bucketId: TBucketId): string {
    return (
      this.options.bucketPrefixOverrides?.[bucketId] ?? `ratelimit:${bucketId}`
    );
  }

  /**
   * Lazily initializes and caches a Ratelimit instance for a bucket config.
   */
  private getLimiter(bucketId: TBucketId): Ratelimit {
    const existing = this.limiterCache.get(bucketId);
    if (existing) return existing;

    const config = this.options.buckets[bucketId];
    if (!config) {
      throw new Error(
        `[RateEngine] Missing configuration for bucket: ${bucketId}`,
      );
    }

    let algorithmImpl;
    const algorithm = config.algorithm ?? "slidingWindow";
    if (algorithm === "tokenBucket") {
      algorithmImpl = Ratelimit.tokenBucket(
        config.requests,
        config.window as Duration,
        config.refillRate ?? config.requests,
      );
    } else if (algorithm === "fixedWindow") {
      algorithmImpl = Ratelimit.fixedWindow(
        config.requests,
        config.window as Duration,
      );
    } else {
      algorithmImpl = Ratelimit.slidingWindow(
        config.requests,
        config.window as Duration,
      );
    }

    const limiter = new Ratelimit({
      redis: this.redis as unknown as ConstructorParameters<
        typeof Ratelimit
      >[0]["redis"],
      limiter: algorithmImpl,
      prefix: this.getBucketPrefix(bucketId),
      analytics: true,
      timeout: this.redisTimeoutMs,
      ephemeralCache: this.options.ephemeralCache ?? this.defaultSharedCache,
    });

    this.limiterCache.set(bucketId, limiter);
    return limiter;
  }

  /**
   * Normalizes rate limiter metrics into a standard RateLimitSnapshot interface.
   */
  private toSnapshot(input: {
    bucketId: TBucketId;
    identifier: string;
    limit: number;
    remaining: number;
    reset: number;
    reason?: RateLimitFailureReason;
    degraded: boolean;
  }): RateLimitSnapshot<TBucketId> {
    return {
      bucketId: input.bucketId,
      identifier: input.identifier,
      limit: input.limit,
      remaining: input.remaining,
      used: Math.max(0, input.limit - input.remaining),
      reset: input.reset,
      resetDate: new Date(input.reset),
      reason: input.reason,
      degraded: input.degraded,
    };
  }

  /**
   * Generates a safe fallback snapshot if the Redis rate limiter goes offline.
   */
  private createFallbackSnapshot(
    bucketId: TBucketId,
    identifier: string,
  ): RateLimitSnapshot<TBucketId> {
    const config = this.options.buckets[bucketId];
    const reset = Date.now() + this.fallbackResetMs;

    return this.toSnapshot({
      bucketId,
      identifier,
      limit: config ? config.requests : 0,
      remaining: config ? config.requests : 0,
      reset,
      reason: "error",
      degraded: true,
    });
  }

  /**
   * Consumes a single token from a specific rate limit bucket.
   *
   * @param bucketId Target bucket ID.
   * @param identifier Unique identifier key (e.g. user ID or IP).
   * @param options Custom parameters (cost, metadata).
   * @param enforceOptions Hooks (like waitUntil for background analytics).
   * @returns A decision representing if the consume is allowed or rate-limited.
   */
  public async consumeBucket(
    bucketId: TBucketId,
    identifier: string,
    options?: ConsumeBucketOptions<TPolicyId>,
    enforceOptions?: EnforceOptions,
  ): Promise<RateLimitDecision<TPolicyId, TBucketId>> {
    try {
      const limiter = this.getLimiter(bucketId);
      const result = await limiter.limit(identifier, {
        rate: options?.rate,
        ip: options?.context?.ip,
        userAgent: options?.context?.userAgent,
        country: options?.context?.country,
      });

      if (result.pending) {
        if (enforceOptions?.waitUntil) {
          enforceOptions.waitUntil(result.pending);
        } else {
          result.pending.catch((error: unknown) => {
            this.logger.error?.(
              "[RateEngine] Background analytics upload failed",
              {
                bucketId,
                error,
              },
            );
          });
        }
      }

      const snapshot = this.toSnapshot({
        bucketId,
        identifier,
        limit: result.limit,
        remaining: result.remaining,
        reset: result.reset,
        reason: result.reason as RateLimitFailureReason | undefined,
        degraded: false,
      });

      return {
        ...snapshot,
        allowed: result.success,
        tier: options?.tier ?? "single",
        policyId: options?.policyId,
        message: options?.message,
      };
    } catch (error) {
      this.logger.error?.("[RateEngine] Bucket consume failed", {
        bucketId,
        identifier,
        error,
      });

      const fallback = this.createFallbackSnapshot(bucketId, identifier);
      return {
        ...fallback,
        allowed: true, // Fail-open inside individual bucket consumes
        tier: options?.tier ?? "single",
        policyId: options?.policyId,
        message: options?.message,
      };
    }
  }

  /**
   * Reads a bucket's token state without consuming any tokens (non-mutating).
   *
   * @param bucketId Target bucket ID.
   * @param identifier Unique identifier key.
   * @returns A snapshot details of remaining tokens and reset timers.
   */
  public async readBucket(
    bucketId: TBucketId,
    identifier: string,
  ): Promise<RateLimitSnapshot<TBucketId>> {
    try {
      const limiter = this.getLimiter(bucketId);
      const result = await limiter.getRemaining(identifier);
      return this.toSnapshot({
        bucketId,
        identifier,
        limit: result.limit,
        remaining: result.remaining,
        reset: result.reset,
        degraded: false,
      });
    } catch (error) {
      this.logger.error?.("[RateEngine] Bucket read failed", {
        bucketId,
        identifier,
        error,
      });
      return this.createFallbackSnapshot(bucketId, identifier);
    }
  }

  /**
   * Resets all consumed tokens for a given identifier inside a specific bucket.
   *
   * @param bucketId Target bucket ID.
   * @param identifier Unique identifier key.
   */
  public async resetBucket(
    bucketId: TBucketId,
    identifier: string,
  ): Promise<void> {
    try {
      const limiter = this.getLimiter(bucketId);
      await limiter.resetUsedTokens(identifier);
    } catch (error) {
      this.logger.error?.("[RateEngine] Failed to reset bucket", {
        bucketId,
        identifier,
        error,
      });
    }
  }

  /**
   * Gets the failure mode of a given policy.
   *
   * @param policyId The policy identifier.
   * @returns "open" to permit requests on timeout, or "closed" to block on timeout.
   */
  public getFailureMode(policyId: TPolicyId): "open" | "closed" {
    const policy = this.options.policies[policyId];
    if (policy && "failureMode" in policy) {
      return policy.failureMode;
    }
    return this.closedFailurePoliciesSet.has(policyId) ? "closed" : "open";
  }

  /**
   * Enforces a multi-stage rate limiting policy sequentially.
   *
   * Evaluates the pipeline stages (e.g. checking global user limits first, then endpoint-specific limits).
   * Stops evaluating immediately and returns the blocked decision on the first stage that fails.
   *
   * @param rawPolicyId The ID of the policy to enforce.
   * @param context Context payloads containing user descriptors (IP, ID, etc.).
   * @param enforceOptions Hooks (like waitUntil for serverless execution).
   * @returns The final allowed or rate-limited decision.
   */
  public async enforce(
    rawPolicyId: TPolicyId,
    context: TContext,
    enforceOptions?: EnforceOptions,
  ): Promise<RateLimitDecision<TPolicyId, TBucketId>> {
    // Resolve dynamic policies (like swapping base policies under progressive throttling)
    const policyId = this.options.resolvePolicy
      ? await this.options.resolvePolicy(rawPolicyId, context)
      : rawPolicyId;

    const policy = this.options.policies[policyId];
    if (!policy) {
      throw new Error(`[RateEngine] Undefined policy: ${policyId}`);
    }

    const failureMode = this.getFailureMode(policyId);
    let lastAllowedDecision: RateLimitDecision<TPolicyId, TBucketId> | null =
      null;

    for (const stage of policy.stages) {
      const bucketId =
        typeof stage.bucketId === "function"
          ? (stage.bucketId as (ctx: TContext) => TBucketId)(context)
          : stage.bucketId;

      const rawIdentifier = stage.identifier(context);
      if (!rawIdentifier) {
        throw new Error(
          `[RateEngine] Missing identifier for policy=${policyId} bucket=${bucketId}`,
        );
      }

      const decision = await this.consumeBucket(
        bucketId,
        rawIdentifier,
        {
          tier: stage.tier,
          policyId,
          message: stage.message,
          context: {
            ip: context.ipAddress,
            userAgent: context.userAgent,
            country: context.country,
          },
        },
        enforceOptions,
      );

      // Handle fail-closed mode when limiter backend is degraded/unavailable
      if (decision.degraded && failureMode === "closed") {
        const blockedDecision: RateLimitDecision<TPolicyId, TBucketId> = {
          ...decision,
          allowed: false,
          message:
            decision.message ??
            "Service temporarily unavailable. Please try again later.",
        };
        if (this.options.onViolation) {
          await this.options.onViolation(context, blockedDecision);
        }
        return blockedDecision;
      }

      if (!decision.allowed) {
        if (this.options.onViolation) {
          await this.options.onViolation(context, decision);
        }
        return decision;
      }

      lastAllowedDecision = decision;
    }

    if (!lastAllowedDecision) {
      throw new Error(`[RateEngine] Policy has no stages defined: ${policyId}`);
    }

    return lastAllowedDecision;
  }

  /**
   * Performs a health check check on the rate limiter Redis connection.
   *
   * @returns Health details.
   */
  public async getHealth(): Promise<{
    healthy: boolean;
    usingFallback: boolean;
    failureCount: number;
    lastFailure: Date | null;
  }> {
    try {
      await this.redis.ping();
      return {
        healthy: true,
        usingFallback: false,
        failureCount: 0,
        lastFailure: null,
      };
    } catch (error) {
      this.logger.error?.("[RateEngine] Health check failed", { error });
      return {
        healthy: false,
        usingFallback: true,
        failureCount: 1,
        lastFailure: new Date(),
      };
    }
  }
}
