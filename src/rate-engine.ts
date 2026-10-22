import { type Duration, Ratelimit } from "@upstash/ratelimit";

import type {
  BucketConfig,
  BucketReadInput,
  ConsumeBucketOptions,
  EnforceOptions,
  RateEngineContext,
  RateEngineInstanceMetrics,
  RateEngineLogger,
  RateEngineOptions,
  RateEngineRedisClient,
  RateLimitDecision,
  RateLimitFailureReason,
  RateLimitPolicy,
  RateLimitSnapshot,
  RateLimitStageDecision,
  RedisPingResult,
  ResetBucketResult,
} from "./types.js";

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
  private redisTimeoutMs: number;
  private fallbackResetMs: number;
  private analytics: boolean;

  // Health telemetry is local to this RateEngine instance.
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
    this.validateOptions(options);
    this.redis = options.redis;
    this.logger = options.logger ?? {};
    this.redisTimeoutMs = options.redisTimeoutMs ?? 1000;
    this.fallbackResetMs = options.fallbackResetMs ?? 60000;
    this.analytics = options.analytics ?? true;
  }

  /**
   * Validates static configuration before the engine handles requests.
   */
  private validateOptions(
    options: RateEngineOptions<TPolicyId, TBucketId, TContext>,
  ): void {
    const assertPositiveInteger = (value: number, name: string) => {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`[RateEngine] ${name} must be a positive safe integer`);
      }
    };

    if (options.redisTimeoutMs !== undefined) {
      assertPositiveInteger(options.redisTimeoutMs, "redisTimeoutMs");
    }
    if (options.fallbackResetMs !== undefined) {
      assertPositiveInteger(options.fallbackResetMs, "fallbackResetMs");
    }

    for (const [bucketId, config] of Object.entries(options.buckets) as Array<
      [TBucketId, BucketConfig]
    >) {
      assertPositiveInteger(config.requests, `Bucket "${bucketId}" requests`);
      const windowMatch = config.window
        .trim()
        .match(/^(\d+(?:\.\d+)?)\s?(ms|s|m|h|d)$/);
      if (!windowMatch || Number(windowMatch[1]) <= 0) {
        throw new Error(
          `[RateEngine] Bucket "${bucketId}" window must be a positive duration`,
        );
      }
      if (config.refillRate !== undefined) {
        if (config.algorithm !== "tokenBucket") {
          throw new Error(
            `[RateEngine] Bucket "${bucketId}" refillRate requires tokenBucket`,
          );
        }
        assertPositiveInteger(
          config.refillRate,
          `Bucket "${bucketId}" refillRate`,
        );
      }
    }

    for (const [policyId, policy] of Object.entries(options.policies) as Array<
      [TPolicyId, RateLimitPolicy<TBucketId, TContext>]
    >) {
      if (policy.stages.length === 0) {
        throw new Error(
          `[RateEngine] Policy has no stages defined: ${policyId}`,
        );
      }
      for (const stage of policy.stages) {
        if (
          typeof stage.bucketId === "string" &&
          !Object.hasOwn(options.buckets, stage.bucketId)
        ) {
          throw new Error(
            `[RateEngine] Policy "${policyId}" references unknown bucket: ${stage.bucketId}`,
          );
        }
      }
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

  /**
   * Validates an identifier before it is passed to the rate limiter.
   *
   * @param raw The raw identifier value from context or a direct caller.
   * @returns The trimmed identifier.
   * @throws If the identifier is empty or exceeds 512 UTF-8 bytes.
   */
  private sanitizeIdentifier(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) {
      throw new Error("[RateEngine] Identifier is empty or whitespace-only");
    }
    if (new TextEncoder().encode(trimmed).byteLength > 512) {
      throw new Error("[RateEngine] Identifier exceeds 512 bytes");
    }
    return trimmed;
  }

  /**
   * Validates the token cost passed to the rate limiter.
   */
  private validateRate(rate: number | undefined): void {
    if (rate !== undefined && (!Number.isSafeInteger(rate) || rate < 1)) {
      throw new Error("[RateEngine] Rate must be a positive safe integer");
    }
  }

  /**
   * Resets all stateful health metrics (consecutive failures, total failures, etc.).
   * Useful in tests or after a confirmed Redis recovery in long-lived processes.
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

    // Upstash's default reset scans inside Lua, which accesses undeclared keys
    // on Dragonfly. Only these exact keys can contribute to the current quota.
    const durationMatch = config.window
      .trim()
      .match(/^(\d+(?:\.\d+)?)\s?(ms|s|m|h|d)$/);
    if (!durationMatch) {
      throw new Error(`[RateEngine] Invalid window for bucket: ${bucketId}`);
    }
    const unitDurations: Record<string, number> = {
      ms: 1,
      s: 1000,
      m: 60_000,
      h: 3_600_000,
      d: 86_400_000,
    };
    const durationMs =
      Number(durationMatch[1]) * unitDurations[durationMatch[2]];
    const resettableAlgorithm: typeof algorithmImpl = () => ({
      ...algorithmImpl(),
      async resetTokens(ctx, identifier) {
        const window = Math.floor(Date.now() / durationMs);
        const keys =
          algorithm === "tokenBucket"
            ? [identifier]
            : algorithm === "fixedWindow"
              ? [`${identifier}:${window}`]
              : [`${identifier}:${window}`, `${identifier}:${window - 1}`];
        await ctx.redis.eval(
          "return redis.call('DEL', unpack(KEYS))",
          keys,
          [],
        );
        ctx.cache?.pop(identifier);
      },
    });

    const limiter = new Ratelimit({
      redis: this.redis as unknown as ConstructorParameters<
        typeof Ratelimit
      >[0]["redis"],
      limiter: resettableAlgorithm,
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
   * Invokes the optional violation hook without changing the enforcement result.
   */
  private async invokeOnViolation(
    context: TContext,
    decision: RateLimitDecision<TPolicyId, TBucketId>,
  ): Promise<void> {
    if (!this.options.onViolation) return;
    try {
      await this.options.onViolation(context, decision);
    } catch (error) {
      this.logger.error?.("[RateEngine] Violation callback failed", { error });
    }
  }

  /**
   * Consumes tokens from a specific rate limit bucket.
   *
   * @param bucketId Target bucket ID.
   * @param rawIdentifier Unique identifier key, such as a user ID or IP.
   * @param options Custom token cost, metadata, and fallback behavior.
   * @param enforceOptions Hooks (like waitUntil for background analytics).
   * @returns A decision representing if the consume is allowed or rate-limited.
   */
  public async consumeBucket(
    bucketId: TBucketId,
    rawIdentifier: string,
    options?: ConsumeBucketOptions<TPolicyId>,
    enforceOptions?: EnforceOptions,
  ): Promise<RateLimitDecision<TPolicyId, TBucketId>> {
    const identifier = this.sanitizeIdentifier(rawIdentifier);
    this.validateRate(options?.rate);
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
              { bucketId, error },
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
   * @returns A snapshot of remaining tokens and reset timers.
   */
  public async readBucket(
    bucketId: TBucketId,
    rawIdentifier: string,
  ): Promise<RateLimitSnapshot<TBucketId>> {
    const identifier = this.sanitizeIdentifier(rawIdentifier);
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
        error,
      });
      return this.createFallbackSnapshot(bucketId, identifier);
    }
  }

  /**
   * Reads multiple buckets concurrently without consuming tokens.
   *
   * @param entries Bucket and identifier pairs.
   * @returns Snapshots in input order.
   */
  public async readBuckets(
    entries: Array<BucketReadInput<TBucketId>>,
  ): Promise<RateLimitSnapshot<TBucketId>[]> {
    return Promise.all(
      entries.map(({ bucketId, identifier }) =>
        this.readBucket(bucketId, identifier),
      ),
    );
  }

  /**
   * Resets all consumed tokens for a given identifier inside a specific bucket.
   *
   * @param bucketId Target bucket ID.
   * @param identifier Unique identifier key.
   */
  public async resetBucket(
    bucketId: TBucketId,
    rawIdentifier: string,
  ): Promise<ResetBucketResult> {
    const identifier = this.sanitizeIdentifier(rawIdentifier);
    const limiter = this.getLimiter(bucketId);

    try {
      await limiter.resetUsedTokens(identifier);
      this.recordSuccess();
      return { ok: true };
    } catch (error) {
      this.recordFailure();
      this.logger.error?.("[RateEngine] Failed to reset bucket", {
        bucketId,
        error,
      });
      return { ok: false, reason: "backend_error" };
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
    if (!policy) {
      throw new Error(`[RateEngine] Undefined policy: ${policyId}`);
    }
    return policy.failureMode;
  }

  /**
   * Enforces a multi-stage rate limiting policy sequentially.
   *
   * Evaluates stages in order and stops at the first blocked decision.
   *
   * @param rawPolicyId The ID of the policy to enforce.
   * @param context Context payloads containing user descriptors (IP, ID, etc.).
   * @param enforceOptions Hooks such as waitUntil for serverless execution.
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
      throw new Error(
        `[RateEngine] Policy resolution returned an unknown policy`,
      );
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
        await this.invokeOnViolation(context, blockedDecision);
        return blockedDecision;
      }

      if (!decision.allowed) {
        const blockedDecision: RateLimitDecision<TPolicyId, TBucketId> = {
          ...decision,
          stages: decisions,
        };
        await this.invokeOnViolation(context, blockedDecision);
        return blockedDecision;
      }
    }

    return this.createAllowedDecision(policyId, decisions);
  }

  /**
   * Pings Redis and measures the round-trip latency.
   *
   * @returns Reachability status and latency.
   */
  public async pingRedis(): Promise<RedisPingResult> {
    const start = Date.now();
    try {
      await this.redis.ping();
      this.recordSuccess();
      return { reachable: true, latencyMs: Date.now() - start };
    } catch (error) {
      this.logger.error?.("[RateEngine] Redis ping failed", { error });
      this.recordFailure();
      return { reachable: false, latencyMs: Date.now() - start };
    }
  }

  /**
   * Returns instance-local failure counters for this RateEngine instance.
   *
   * @returns In-memory counters for this process-local instance.
   */
  public getInstanceMetrics(): RateEngineInstanceMetrics {
    return {
      consecutiveFailures: this.consecutiveFailures,
      totalFailures: this.totalFailures,
      lastFailure: this.lastFailure,
      lastSuccess: this.lastSuccess,
    };
  }
}
