<img src="https://raw.githubusercontent.com/cpauldev/rate-engine/main/banner.png" alt="RateEngine Banner" width="100%" />

# RateEngine: Rate Limiting Engine for TypeScript

![TypeScript](https://img.shields.io/badge/-TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white) ![Rate Limiting](https://img.shields.io/badge/-Rate_Limiting-C2410C?style=flat-square) ![Pipelines](https://img.shields.io/badge/-Policy_Pipelines-0F766E?style=flat-square) ![Redis](https://img.shields.io/badge/-Redis-DC382D?style=flat-square&logo=redis&logoColor=white) ![License](https://img.shields.io/badge/-MIT_License-blue?style=flat-square) [![Changelog](https://img.shields.io/badge/Changelog-v0.3.0-blue?style=flat-square)](./CHANGELOG.md)

RateEngine is a client-agnostic, multi-stage rate limiting policy engine for TypeScript, powered by `@upstash/ratelimit`. It helps you define Redis-backed rate limit buckets, enforce ordered policy pipelines, choose fail-open or fail-closed behavior, and return standard HTTP rate-limit responses with minimal route-handler boilerplate.

It is designed for developers using **Redis or Valkey** through providers like Upstash, ElastiCache, Redis Cloud, DragonflyDB, KeyDB, or similar infrastructure who want cleaner, config-driven rate-limiting logic. It is especially useful for **serverless, edge, and Node.js APIs** where in-memory limiters do not scale reliably across cold starts, regions, or multiple runtime instances. Use it when you need **hierarchical limits** such as global IP, user-account, and endpoint-specific checks; explicit **fail-open or fail-closed behavior** during Redis degradation; and built-in helpers for standard rate-limit headers and `429` responses.

#### 🤖 Ask your coding assistant

> "Audit my codebase to see if adding the `rate-engine` package on npm is beneficial. If so, explain why and draft an integration plan identifying endpoints to protect, bucket configurations, and fail-open vs. fail-closed routes using the package README and source code."

---

## Why use RateEngine?

RateEngine uses `@upstash/ratelimit` under the hood to execute rate-limit checks using sliding window, fixed window, or token bucket algorithms. It adds a structured policy layer around those checks so application code can stay focused on request handling instead of repeated rate-limit orchestration.

| Feature                  | Raw `@upstash/ratelimit`                                                                 | With **RateEngine**                                                                                                  |
| :----------------------- | :--------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------- |
| **Chained Checks**       | Requires manually coordinating multiple limiter calls in route handlers.                 | 🔗 **Policy Pipelines.** Sequentially evaluates declared multi-stage policies, such as `Global ➔ User ➔ Endpoint`.   |
| **Fail-Safe Modes**      | Requires route-level error handling and custom fallback behavior.                        | ⚙️ **Configurable.** Define fail-open or fail-closed behavior at the policy level, or per direct bucket call.        |
| **Serverless Lifecycle** | Requires handling `result.pending` when the runtime needs background work to stay alive. | ⚡ **Handled.** Passes background analytics promises to your environment's `waitUntil` hook when provided.           |
| **HTTP Responses**       | Returns raw metrics such as `limit`, `remaining`, and `reset`.                           | 🌐 **Built-in Helpers.** Generates rate-limit headers and standard `429` JSON responses.                             |
| **Dynamic Routing**      | Requires custom route logic to switch between different limiter policies at runtime.     | 🔄 **Resolver Hook.** Use `resolvePolicy` to redirect requests to stricter or alternative policies based on context. |
| **Client Flexibility**   | Common usage is tied to `@upstash/redis`; TCP clients require adapter logic.             | 🧩 **Duck-Typed Redis Client.** Accepts clients exposing the Redis command methods RateEngine needs.                 |
| **Violation Tracking**   | Requires adding telemetry calls in each blocked path.                                    | 🛡️ **Violation Hook.** Centralize logging, telemetry, or abuse tracking through `onViolation`.                       |
| **Memory Optimization**  | Each `Ratelimit` instance may use its own cache unless a shared map is passed manually.  | 🧠 **Shared Cache.** Shares one in-memory cache map across bucket limiters by default.                               |

---

## Installation

Install RateEngine via your preferred package manager:

```bash
# npm
npm install rate-engine

# yarn
yarn add rate-engine

# pnpm
pnpm add rate-engine

# bun
bun add rate-engine
```

---

## Getting Started

### 1. Define buckets

Create a `buckets.ts` file to define your rate-limit windows and capacities:

```typescript
// buckets.ts
import { type BucketConfig } from "rate-engine";

export const APP_BUCKETS = {
  "global:ip": {
    requests: 500,
    window: "1 m",
  },
  "global:user": {
    requests: 300,
    window: "1 m",
    algorithm: "slidingWindow",
  },
  "auth:login": {
    requests: 5,
    window: "15 m",
    algorithm: "fixedWindow",
  },
  "api:default": {
    requests: 100,
    window: "1 m",
  },
  "api:burst": {
    requests: 50,
    window: "10 s",
    algorithm: "tokenBucket",
    refillRate: 5,
  },
} as const satisfies Record<string, BucketConfig>;

export type AppBucketId = keyof typeof APP_BUCKETS;
```

### 2. Define policies

Create a `policies.ts` file to define your multi-stage checking pipelines:

```typescript
// policies.ts
import { type RateLimitPolicy } from "rate-engine";

import { type AppBucketId } from "./buckets";

export type AppContext = {
  userId?: string;
  ipAddress?: string;
  userAgent?: string;
};

export const APP_POLICIES = {
  "auth.login": {
    // Critical endpoint: fail closed if Redis is degraded.
    failureMode: "closed",
    stages: [
      {
        bucketId: "global:ip",
        identifier: (ctx) => ctx.ipAddress,
        tier: "global",
        message: "Too many requests from this IP.",
      },
      {
        bucketId: "auth:login",
        identifier: (ctx) => ctx.userId ?? ctx.ipAddress,
        tier: "endpoint",
        message: "Too many login attempts. Please try again later.",
      },
    ],
  },
  "api.read": {
    // Lower-risk endpoint: fail open to avoid unnecessary site outages.
    failureMode: "open",
    stages: [
      {
        bucketId: "api:default",
        identifier: (ctx) => ctx.userId ?? ctx.ipAddress,
        tier: "single",
      },
    ],
  },
} as const satisfies Record<string, RateLimitPolicy<AppBucketId, AppContext>>;

export type AppPolicyId = keyof typeof APP_POLICIES;
```

### 3. Instantiate RateEngine

Create a `rate-engine.ts` file to initialize the RateEngine instance:

```typescript
// rate-engine.ts
import { Redis } from "@upstash/redis";
import { RateEngine } from "rate-engine";

import { APP_BUCKETS, type AppBucketId } from "./buckets";
import { APP_POLICIES, type AppContext, type AppPolicyId } from "./policies";

export const rateEngine = new RateEngine<AppPolicyId, AppBucketId, AppContext>({
  redis: new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  }),
  logger: console,
  buckets: APP_BUCKETS,
  policies: APP_POLICIES,

  // Optional dynamic policy resolution.
  resolvePolicy: async (policyId, context) => {
    // Example: return a stricter policy for suspicious users.
    return policyId;
  },

  // Optional central violation hook.
  onViolation: async (context, decision) => {
    console.warn(
      `[RateEngine] ${context.ipAddress ?? "unknown"} exceeded ${decision.bucketId}`,
      {
        policyId: decision.policyId,
        tier: decision.tier,
        degraded: decision.degraded,
      },
    );
  },
});
```

### 4. Enforce limits in an API handler

Use `enforce()` inside your route handler. For serverless or edge runtimes, pass `waitUntil` so background analytics work can be completed by the platform.

```typescript
// Next.js Route Handler Example
import { type NextRequest, NextResponse } from "next/server";

import { getRateLimitHeaders, toRateLimitResponse } from "rate-engine";

import { rateEngine } from "@/lib/rate-engine";

export async function POST(req: NextRequest, event: { waitUntil: any }) {
  const ipAddress =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "127.0.0.1";

  const decision = await rateEngine.enforce(
    "auth.login",
    {
      ipAddress,
      userId: "user_123",
      userAgent: req.headers.get("user-agent") ?? undefined,
    },
    {
      waitUntil: (promise) => event.waitUntil(promise),
    },
  );

  if (!decision.allowed) {
    return toRateLimitResponse(decision, {
      message: "Too many login attempts. Please try again later.",
      errorCode: "LOGIN_LIMIT_EXCEEDED",
    });
  }

  const headers = getRateLimitHeaders(decision);

  // Continue with authentication...
  return NextResponse.json({ success: true }, { headers });
}
```

---

## Core Concepts

### Buckets

A **bucket** defines a rate-limit capacity, window, and algorithm.

```typescript
{
  requests: 100,
  window: "1 m",
  algorithm: "slidingWindow"
}
```

Supported algorithms:

- `slidingWindow`
- `fixedWindow`
- `tokenBucket`

For token buckets, you can also provide `refillRate`.

### Policies

A **policy** is an ordered list of stages. Each stage chooses a bucket and resolves the identifier to rate limit.

```typescript
{
  failureMode: "closed",
  stages: [
    {
      bucketId: "global:ip",
      identifier: (ctx) => ctx.ipAddress,
      tier: "global",
    },
    {
      bucketId: "auth:login",
      identifier: (ctx) => ctx.userId ?? ctx.ipAddress,
      tier: "endpoint",
    },
  ],
}
```

Policies are evaluated sequentially and stop at the first blocked stage.

### Failure modes

RateEngine supports two fallback modes when Redis is unavailable or a rate-limit operation fails:

| Mode     | Behavior                                       | Common use                                                                   |
| :------- | :--------------------------------------------- | :--------------------------------------------------------------------------- |
| `open`   | Allows the request during backend degradation. | Public reads, low-risk APIs, availability-first routes.                      |
| `closed` | Blocks the request during backend degradation. | Login, password reset, checkout, OTP, write-heavy or abuse-sensitive routes. |

`enforce()` uses the policy failure mode. Direct `consumeBucket()` calls default to fail open unless you pass `failureMode: "closed"`.

### Effective quota reporting

For multi-stage policies, RateEngine returns a conservative root-level decision optimized for HTTP headers.

If all stages pass:

- `remaining` comes from the evaluated stage with the lowest remaining count.
- `limit` comes from that same lowest-remaining stage.
- `reset` comes from the stage with the latest reset timestamp.
- `stages` contains the per-stage decisions.
- `effective` identifies which buckets contributed the root-level `limit`, `remaining`, and `reset` values.

This means root `limit`, `remaining`, and `reset` fields can be a composite of multiple stages. They are intended for conservative client-facing headers, not as a replacement for exact per-bucket state. Use `decision.stages` when you need exact per-stage quota state.

### Sequential execution

RateEngine evaluates policy stages sequentially and short-circuits on the first violation. This avoids downstream token consumption when an earlier stage already blocks the request.

For example, if a request is already blocked by a global IP limit, RateEngine will not also consume from the endpoint-specific bucket.

> [!TIP]
> Each additional stage may add one Redis rate-limit operation. Keep latency-sensitive policies concise, and reserve longer pipelines for routes where the added precision is worth the extra round trips.

---

## Redis Client Compatibility

RateEngine is client-agnostic. It does not require a strict `@upstash/redis` instance; instead, it uses a duck-typed Redis client interface.

RateEngine is designed to work with Redis-compatible clients that expose the command methods required by `@upstash/ratelimit`, including:

- `eval`
- `evalsha`
- `incr`
- `expire`
- `ping`

It has been designed for use with:

- ☁️ **Cloud/enterprise managed Redis:** AWS ElastiCache, Redis Cloud, Google Memorystore, and Azure Managed Redis through TCP clients such as `ioredis` or `redis`.
- ⚡ **Serverless/edge Redis:** Upstash Redis through HTTP REST using `@upstash/redis`.
- 🚀 **Redis-compatible engines:** DragonflyDB, KeyDB, and Valkey.

Provider-specific behavior should be verified in your deployment environment.

> [!NOTE]
> **Flipped environments:** The usual local-vs-production setup can be reversed. If you self-host staging/production with DragonflyDB, Valkey, or ElastiCache and use Upstash for local development tunnels, prefer an explicit variable such as `REDIS_PROVIDER=upstash|dragonfly|valkey` instead of relying only on `NODE_ENV`.

### Advanced: Environment-aware Redis proxy

The following proxy normalizes `eval` and `evalsha` calls between `ioredis` and `@upstash/redis`.

```typescript
import { Redis as UpstashRedis } from "@upstash/redis";
import IORedis from "ioredis";

const provider = process.env.REDIS_PROVIDER ?? "upstash";

let client: UpstashRedis | IORedis | null = null;

function getRedisClient() {
  if (client) return client;

  if (provider === "tcp") {
    client = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379");
  } else {
    client = new UpstashRedis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    });
  }

  return client;
}

export const redis = new Proxy({} as any, {
  get(_target, prop) {
    const activeClient = getRedisClient();

    if (prop === "eval" || prop === "evalsha") {
      return async (scriptOrSha: string, keys: string[], args: any[] = []) => {
        if (provider === "tcp") {
          return await (activeClient as IORedis)[prop](
            scriptOrSha,
            keys.length,
            ...keys,
            ...args,
          );
        }

        return await (activeClient as UpstashRedis)[prop](
          scriptOrSha,
          keys,
          args,
        );
      };
    }

    const value = (activeClient as any)[prop];
    return typeof value === "function" ? value.bind(activeClient) : value;
  },
});
```

---

## API Reference

### `RateEngine` constructor

The `RateEngine` class is initialized with an options object.

| Parameter               | Type                                                     | Required | Default      | Description                                                                                                                        |
| :---------------------- | :------------------------------------------------------- | :------- | :----------- | :--------------------------------------------------------------------------------------------------------------------------------- |
| `redis`                 | `RateEngineRedisClient`                                  | Yes      | -            | A duck-typed Redis client instance.                                                                                                |
| `buckets`               | `Record<TBucketId, BucketConfig>`                        | Yes      | -            | Configuration for all available rate-limit buckets.                                                                                |
| `policies`              | `Record<TPolicyId, RateLimitPolicy>`                     | Yes      | -            | Named policies specifying ordered evaluation stages.                                                                               |
| `logger`                | `RateEngineLogger`                                       | No       | -            | Logger interface for rate-limit errors and background analytics failures.                                                          |
| `redisTimeoutMs`        | `number`                                                 | No       | `1000`       | Redis response timeout before fallback behavior is triggered.                                                                      |
| `fallbackResetMs`       | `number`                                                 | No       | `60000`      | Reset duration used in degraded fallback snapshots.                                                                                |
| `analytics`             | `boolean`                                                | No       | `true`       | Enables `@upstash/ratelimit` analytics uploads. Set to `false` to opt out; local health counters are never uploaded by RateEngine. |
| `bucketPrefixOverrides` | `Partial<Record<TBucketId, string>>`                     | No       | -            | Optional per-bucket Redis key prefix overrides.                                                                                    |
| `resolvePolicy`         | `(policyId, context) => Promise<TPolicyId> \| TPolicyId` | No       | -            | Hook for dynamically redirecting a request to another policy.                                                                      |
| `ephemeralCache`        | `Map<string, number>`                                    | No       | Shared `Map` | Optional custom shared cache map.                                                                                                  |
| `onViolation`           | `(context, decision) => Promise<void> \| void`           | No       | -            | Callback triggered when a rate limit is breached or a fail-closed policy blocks due to degradation.                                |

---

### Instance methods

#### 1. `enforce(policyId, context, options?)`

Sequentially evaluates the stages of a named policy.

```typescript
const decision = await rateEngine.enforce("auth.login", {
  ipAddress: "203.0.113.10",
  userId: "user_123",
});
```

- **Arguments**
  - `policyId` (`TPolicyId`): The policy ID to enforce.
  - `context` (`TContext`): Request context used by stage identifier functions.
  - `options` (`EnforceOptions`): Optional hooks such as `{ waitUntil: (promise) => void }`.

- **Returns**
  - `Promise<RateLimitDecision>`

Returned decisions may include:

```typescript
type RateLimitDecision = {
  allowed: boolean;
  bucketId: string;
  identifier: string;
  limit: number;
  remaining: number;
  used: number;
  reset: number;
  resetDate: Date;
  degraded: boolean;
  policyId?: string;
  tier: "single" | "global" | "category" | "endpoint";
  message?: string;
  stages?: RateLimitStageDecision[];
  effective?: EffectiveQuotaMeta;
};
```

`stages` contains per-stage decision snapshots. `effective` identifies which stage supplied the root `limit`, `remaining`, and `reset` values.

> [!TIP]
> In multi-stage policies, root quota fields are optimized for conservative client-facing headers. For exact per-stage state, inspect `decision.stages`.

---

#### 2. `consumeBucket(bucketId, identifier, options?, enforceOptions?)`

Consumes a token from one bucket without running a full policy pipeline.

```typescript
const decision = await rateEngine.consumeBucket("api:default", "user_123", {
  failureMode: "closed",
});
```

- **Arguments**
  - `bucketId` (`TBucketId`): The target bucket ID.
  - `identifier` (`string`): Unique actor identifier, such as an IP, user ID, or API key.
  - `options` (`ConsumeBucketOptions`): Options such as `{ rate, context, tier, policyId, message, failureMode }`.
  - `enforceOptions` (`EnforceOptions`): Optional hooks such as `{ waitUntil }`.

- **Returns**
  - `Promise<RateLimitDecision>`

> [!WARNING]
> Direct calls to `consumeBucket()` bypass policy-level pipeline checks. Direct bucket consumption defaults to fail open on Redis errors. Pass `failureMode: "closed"` for sensitive direct bucket checks.

---

#### 3. `readBucket(bucketId, identifier)`

Reads the current state of a bucket without consuming a token.

```typescript
const snapshot = await rateEngine.readBucket("api:default", "user_123");
```

- **Returns**
  - `Promise<RateLimitSnapshot>`

---

#### 4. `resetBucket(bucketId, identifier)`

Resets the consumed tokens for a bucket and identifier.

```typescript
await rateEngine.resetBucket("auth:login", "user_123");
```

A successful reset also records Redis connectivity as healthy for the stateful health tracker.

- **Returns**
  - `Promise<void>`

---

#### 5. `getHealth()`

Pings Redis and returns stateful health telemetry.

```typescript
const health = await rateEngine.getHealth();
```

- **Returns**

```typescript
Promise<{
  healthy: boolean;
  usingFallback: boolean;
  consecutiveFailures: number;
  totalFailures: number;
  lastFailure: Date | null;
  lastSuccess: Date | null;
}>;
```

> [!NOTE]
> Health telemetry is stored in memory on the current `RateEngine` instance. In serverless, edge, or horizontally scaled deployments, counters reflect only the current runtime instance, not global Redis health.

---

#### 6. `resetHealth()`

Clears stateful health telemetry.

```typescript
rateEngine.resetHealth();
```

This resets:

- `consecutiveFailures`
- `totalFailures`
- `lastFailure`
- `lastSuccess`

Useful for tests, administrative resets, or long-running processes that want to clear historical health counters after recovery.

- **Returns**
  - `void`

---

## HTTP Adapters

RateEngine includes framework-agnostic helpers for returning rate-limit status to clients.

### `toRateLimitResponse(decision, options?)`

Creates a standard `429 Too Many Requests` JSON response.

```typescript
return toRateLimitResponse(decision, {
  message: "Too many requests. Please try again later.",
  errorCode: "RATE_LIMIT_EXCEEDED",
});
```

Response body:

```json
{
  "error": "RATE_LIMIT_EXCEEDED",
  "message": "Too many requests. Please try again later.",
  "retryAfter": 60,
  "degraded": false
}
```

### `toOAuthSlowDownResponse(decision, options?)`

Creates an OAuth-style `slow_down` response for polling and device-flow endpoints.

```typescript
return toOAuthSlowDownResponse(decision, {
  message: "Polling too frequently. Please wait before trying again.",
});
```

Response body:

```json
{
  "error": "slow_down",
  "error_description": "Polling too frequently. Please wait before trying again.",
  "retry_after": 60,
  "degraded": false
}
```

### `getRateLimitHeaders(decision)`

Builds rate-limit headers from a decision.

```typescript
const headers = getRateLimitHeaders(decision);
```

Use it on successful responses when clients need quota metadata before they hit a limit:

```typescript
import { getRateLimitHeaders, toRateLimitResponse } from "rate-engine";

const decision = await rateEngine.enforce("translate.request", {
  apiKeyId: "key_123",
});

if (!decision.allowed) {
  return toRateLimitResponse(decision);
}

const result = await translate(request);

return Response.json(result, {
  headers: getRateLimitHeaders(decision),
});
```

Returned headers include:

```http
RateLimit-Limit: 100
RateLimit-Remaining: 42
RateLimit-Reset: 60
```

---

## Development

To build the package and generate TypeScript declarations:

```bash
bun run build
```

To run the package unit tests:

```bash
bun run test
```

To run the package type check:

```bash
bun run typecheck
```

After building, verify the published runtime exports:

```bash
bun run test:smoke
```

---

## Related Packages

- [`route-engine`](https://github.com/cpauldev/route-engine) for safe HTTP route boundaries.
- [`redact-log`](https://github.com/cpauldev/redact-log) for safe logging.
- [`secret-engine`](https://github.com/cpauldev/secret-engine) for context-bound encryption and secret handling.
- [`session-engine`](https://github.com/cpauldev/session-engine) for browser session and cache lifecycle management.

---

## License

MIT © [Christian Paul](https://github.com/cpauldev)
