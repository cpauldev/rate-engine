import { type Duration, Ratelimit } from "@upstash/ratelimit";

import type {
  ConsumeBucketOptions,
  EnforceOptions,
  RateEngineContext,
  RateEngineLogger,
  RateEngineOptions,
  RateEngineRedisClient,
  RateLimitDecision,
  RateLimitFailureReason,
  RateLimitSnapshot,
  RateLimitStageDecision,
} from "./types";

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
  private analytics: boolean;

  // Stateful health tracking metrics
  private consecutiveFailures = 0;
  private totalFailures = 0;
  private lastFailure: Date | null = null;
  private lastSuccess: Date | null = null;

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
    this.analytics = options.analytics ?? true;

    if (options.closedFailurePolicies instanceof Set) {
      this.closedFailurePoliciesSet = options.closedFailurePolicies;
    } else if (Array.isArray(options.closedFailurePolicies)) {
      this.closedFailurePoliciesSet = new Set(options.closedFailurePolicies);
    } else {
      this.closedFailurePoliciesSet = new Set();
    }
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.lastSuccess = new Date();
  }

  private recordFailure(): void {
    this.consecutiveFailures++;
    this.totalFailures++;
    this.lastFailure = new Date();
  }

  private getHealthStatus(healthy: boolean): {
    healthy: boolean;
    usingFallback: boolean;
    failureCount: number;
    consecutiveFailures: number;
    totalFailures: number;
    lastFailure: Date | null;
    lastSuccess: Date | null;
  } {
    return {
      healthy,
      usingFallback: !healthy,
      failureCount: healthy ? 0 : this.consecutiveFailures,
      consecutiveFailures: this.consecutiveFailures,
      totalFailures: this.totalFailures,
      lastFailure: this.lastFailure,
      lastSuccess: this.lastSuccess,
    };
  }

  /**
   * Resets all stateful health metrics (consecutive failures, total failures, etc.).
   */
  public resetHealth(): void {
    this.consecutiveFailures = 0;
    this.totalFailures = 0;
    this.lastFailure = null;
    this.lastSuccess = null;
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
      analytics: this.analytics,
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

  private createAllowedDecision(
    policyId: TPolicyId,
    decisions: RateLimitStageDecision<TPolicyId, TBucketId>[],
  ): RateLimitDecision<TPolicyId, TBucketId> {
    const lowestRemainingDecision = decisions.reduce((lowest, current) =>
      current.remaining < lowest.remaining ? current : lowest,
    );

    const latestResetDecision = decisions.reduce((latest, current) =>
      current.reset > latest.reset ? current : latest,
    );

    return {
      ...lowestRemainingDecision,
      reset: latestResetDecision.reset,
      resetDate: latestResetDecision.resetDate,
      allowed: true,
      policyId,
      stages: decisions,
      effective: {
        composite:
          lowestRemainingDecision.bucketId !== latestResetDecision.bucketId,
        limitSourceBucketId: lowestRemainingDecision.bucketId,
        remainingSourceBucketId: lowestRemainingDecision.bucketId,
        resetSourceBucketId: latestResetDecision.bucketId,
      },
    };
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
    const limiter = this.getLimiter(bucketId);

    try {
      const result = await limiter.limit(identifier, {
        rate: options?.rate,
        ip: options?.context?.ip,
        userAgent: options?.context?.userAgent,
        country: options?.context?.country,
      });

      this.recordSuccess();

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
      this.recordFailure();
      this.logger.error?.("[RateEngine] Bucket consume failed", {
        bucketId,
        identifier,
        error,
      });

      const fallback = this.createFallbackSnapshot(bucketId, identifier);
      const failureMode = options?.failureMode ?? "open";
      const fallbackMessage =
        options?.message ??
        (failureMode === "closed"
          ? "Rate limiter unavailable. Please try again later."
          : undefined);

      return {
        ...fallback,
        allowed: failureMode === "open",
        tier: options?.tier ?? "single",
        policyId: options?.policyId,
        message: fallbackMessage,
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
    const limiter = this.getLimiter(bucketId);

    try {
      const result = await limiter.getRemaining(identifier);
      this.recordSuccess();
      return this.toSnapshot({
        bucketId,
        identifier,
        limit: result.limit,
        remaining: result.remaining,
        reset: result.reset,
        degraded: false,
      });
    } catch (error) {
      this.recordFailure();
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
    const limiter = this.getLimiter(bucketId);

    try {
      await limiter.resetUsedTokens(identifier);
      this.recordSuccess();
    } catch (error) {
      this.recordFailure();
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
    if (!policy.stages || policy.stages.length === 0) {
      throw new Error(`[RateEngine] Policy has no stages defined: ${policyId}`);
    }
    const decisions: RateLimitStageDecision<TPolicyId, TBucketId>[] = [];

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
          failureMode,
          context: {
            ip: context.ipAddress,
            userAgent: context.userAgent,
            country: context.country,
          },
        },
        enforceOptions,
      );
      decisions.push(decision);

      // Handle fail-closed mode when limiter backend is degraded/unavailable
      if (decision.degraded && failureMode === "closed") {
        const blockedDecision: RateLimitDecision<TPolicyId, TBucketId> = {
          ...decision,
          allowed: false,
          message:
            decision.message ??
            "Service temporarily unavailable. Please try again later.",
          stages: decisions,
        };
        if (this.options.onViolation) {
          await this.options.onViolation(context, blockedDecision);
        }
        return blockedDecision;
      }

      if (!decision.allowed) {
        const blockedDecision: RateLimitDecision<TPolicyId, TBucketId> = {
          ...decision,
          stages: decisions,
        };
        if (this.options.onViolation) {
          await this.options.onViolation(context, blockedDecision);
        }
        return blockedDecision;
      }
    }

    return this.createAllowedDecision(policyId, decisions);
  }

  /**
   * Performs a health check on the rate limiter Redis connection.
   *
   * @returns Health details.
   */
  public async getHealth(): Promise<{
    healthy: boolean;
    usingFallback: boolean;
    failureCount: number;
    consecutiveFailures: number;
    totalFailures: number;
    lastFailure: Date | null;
    lastSuccess: Date | null;
  }> {
    try {
      await this.redis.ping();
      this.recordSuccess();
      return this.getHealthStatus(true);
    } catch (error) {
      this.logger.error?.("[RateEngine] Health check failed", { error });
      this.recordFailure();
      return this.getHealthStatus(false);
    }
  }
}
