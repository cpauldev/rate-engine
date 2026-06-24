<img src="https://raw.githubusercontent.com/cpauldev/rate-engine/main/banner.png" alt="RateEngine Banner" width="100%" />

# RateEngine: Rate Limiting Engine for TypeScript

![TypeScript](https://img.shields.io/badge/-TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white) ![Redis](https://img.shields.io/badge/-Redis-DC382D?style=flat-square&logo=redis&logoColor=white) ![License](https://img.shields.io/badge/-MIT_License-blue?style=flat-square)

RateEngine is a client-agnostic, multi-stage rate limiting engine for TypeScript, powered by `@upstash/ratelimit`. Designed for tiered pipelines (Global to Endpoint-level) with fail-open/fail-closed safety, supporting any Redis-compatible backend.

#### 🤖 Ask your coding assistant

> "Audit my codebase to see if adding the `rate-engine` package on npm is beneficial. If so, explain why and draft an integration plan (identifying endpoints to protect, bucket configurations, and fail-open vs. fail-closed routes) following the package's README guide and source code."

---

## Features (vs. Raw `@upstash/ratelimit`)

While RateEngine uses `@upstash/ratelimit` under the hood to execute rate limit checks (supporting sliding window, fixed window, or token bucket), it acts as a structured wrapper that eliminates low-level middleware boilerplate:

| Feature                  | Raw `@upstash/ratelimit`                                                                                                                   | With **RateEngine**                                                                                                                |
| :----------------------- | :----------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------- |
| **Chained Checks**       | Requires writing manual nested conditional statements in your handlers to enforce multiple layers of limits.                               | 🔗 **Automatic.** Sequentially evaluates a declared multi-stage pipeline (`Global ➔ Endpoint`) in a single call.                   |
| **Fail-Safe Modes**      | Throws an error on timeout/failure. Standard fail-open or fail-closed behaviors must be implemented manually per route.                    | ⚙️ **Configurable.** Define declarative fail-open vs. fail-closed (block request) policies directly in the config.                 |
| **Serverless Lifecycle** | Developer must catch and process the background analytics promise (`result.pending`) to prevent early serverless execution halts.          | ⚡ **Handled.** Propagates the background analytics promise directly to your environment's `waitUntil` lifecycle method.           |
| **HTTP Responses**       | Returns raw metrics (`limit`, `remaining`, `reset`). Formatting standard headers and 429 JSON responses must be coded manually.            | 🌐 **Built-in.** Exposes standard Web API-compliant `toRateLimitResponse()` and `getRateLimitHeaders()` helpers.                   |
| **Dynamic Routing**      | Requires manual conditional logic before instantiation to select different rate-limiting thresholds at runtime.                            | 🔄 **Built-in Hook.** Exposes a `resolvePolicy` hook to dynamically redirect requests to stricter rules based on state.            |
| **Client Flexibility**   | Strictly typed to `@upstash/redis`. Integrating TCP clients (like `ioredis`) for local development requires custom wrappers.               | 🧩 **Duck-Typed.** Accepts any Redis client that implements `eval`, `evalsha`, `incr`, `expire`, and `ping` (TCP or HTTP).         |
| **Violation Tracking**   | Requires manual telemetry calls inside every blocked path to track rate limit violations.                                                  | 🛡️ **Built-in Hook.** Exposes an `onViolation` lifecycle callback to centralize telemetry, logging, or blocking of abusive actors. |
| **Memory Optimization**  | Each `Ratelimit` instance creates its own in-memory cache map unless a shared Map is manually instantiated and passed to all constructors. | 🧠 **Shared Cache.** Shares a single in-memory Map cache across all bucket limiters by default.                                    |

---

## Who is it for?

**RateEngine** is built for developers who:

- 🛠️ **Use Redis** (via Upstash or any TCP client) and want to write clean, structured rate-limiting logic without managing raw connection and setup boilerplate.
- ⚡ **Build Serverless or Edge APIs** (Next.js, Cloudflare Workers, AWS Lambda) where traditional in-memory limiters reset on every cold start or server scale event.
- 🔗 **Need Hierarchical/Tiered Limits** (e.g., checking a global limit, then an IP limit, then an endpoint limit) and want to avoid writing nested, complex `if/else` checks for each rate limit stage.
- 🛡️ **Value API Resilience** and want to automatically allow (fail-open) or block (fail-closed) requests if the Redis database goes down or times out.
- 🌐 **Want Zero Boilerplate** for generating standard HTTP rate-limit headers and JSON error responses.

---

## Installation

Install **RateEngine** via your preferred package manager:

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

## Redis Client Compatibility

**RateEngine** is client-agnostic. It does not enforce a strict instance type of `@upstash/redis`, but instead relies on **duck-typing** the Redis command signatures.

This makes it extremely easy to switch between environments:

- **Production (Serverless/Edge):** Connect via HTTP REST using `@upstash/redis`.
- **Development / Local (Docker/TCP):** Connect via TCP using `ioredis` or standard `redis` clients, or run a local **DragonflyDB** instance.

As long as the client you pass to the constructor exposes `eval`, `evalsha`, `incr`, `expire`, and `ping` methods, RateEngine will work seamlessly.

### Example: Environment-Aware Redis Proxy

Here is a simple example showing how you can write a proxy to seamlessly route traffic between `ioredis` (for local dev/DragonflyDB) and `@upstash/redis` (for production) based on an environment variable:

```typescript
import { Redis as UpstashRedis } from "@upstash/redis";
import IORedis from "ioredis";

const isProduction = process.env.NODE_ENV === "production";

// Lazily initialize clients to prevent connection issues at build-time
let client: UpstashRedis | IORedis | null = null;
function getRedisClient() {
  if (client) return client;

  if (isProduction) {
    client = new UpstashRedis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    });
  } else {
    client = new IORedis(process.env.REDIS_URL || "redis://localhost:6379");
  }
  return client;
}

// A unified, duck-typed Redis interface compatible with RateEngine
export const redis = new Proxy({} as any, {
  get(_target, prop) {
    const activeClient = getRedisClient();

    // Normalizing the difference in eval/evalsha signature between Upstash (REST) and IORedis (TCP)
    if (prop === "eval" || prop === "evalsha") {
      return async (script: string, keys: string[], args: any[] = []) => {
        if (!isProduction) {
          // IORedis: client.eval(script, numKeys, ...keys, ...args)
          return await (activeClient as IORedis)[prop](
            script,
            keys.length,
            ...keys,
            ...args,
          );
        }
        // Upstash: client.eval(script, keys[], args[])
        return await (activeClient as UpstashRedis)[prop](script, keys, args);
      };
    }

    const value = (activeClient as any)[prop];
    return typeof value === "function" ? value.bind(activeClient) : value;
  },
});
```

---

## Getting Started

### 1. Define Custom Buckets & Policies

First, create a `buckets.ts` file to define your rate limit windows and capacities:

```typescript
// buckets.ts
import { type BucketConfig } from "rate-engine";

export const APP_BUCKETS = {
  "global:ip": { requests: 500, window: "1 m" }, // Defaults to slidingWindow
  "global:user": { requests: 300, window: "1 m", algorithm: "slidingWindow" },
  "auth:login": { requests: 5, window: "15 m", algorithm: "fixedWindow" },
  "api:default": { requests: 100, window: "1 m" },
  "api:burst": {
    requests: 50,
    window: "10 s",
    algorithm: "tokenBucket",
    refillRate: 5,
  },
} as const satisfies Record<string, BucketConfig>;

export type AppBucketId = keyof typeof APP_BUCKETS;
```

Next, create a `policies.ts` file to define your multi-stage checking pipelines:

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
    failureMode: "closed", // Critical endpoint: fails CLOSED if Redis goes down
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
    failureMode: "open", // Less critical: fails OPEN to prevent site outages
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

### 2. Instantiate RateEngine

Create a `rate-engine.ts` file to initialize the RateEngine instance:

```typescript
// rate-engine.ts
import { Redis } from "@upstash/redis";
import { RateEngine } from "rate-engine";

import { APP_BUCKETS, type AppBucketId } from "./buckets";
import { APP_POLICIES, type AppContext, type AppPolicyId } from "./policies";

export const rateEngine = new RateEngine<AppPolicyId, AppBucketId, AppContext>({
  redis: new Redis({ url: "...", token: "..." }), // Any Upstash-compatible Redis client
  logger: console,
  buckets: APP_BUCKETS,
  policies: APP_POLICIES,

  // Custom Dynamic policy resolution (e.g. progressive throttling)
  resolvePolicy: async (policyId, context) => {
    // Dynamically downgrade or override policy rules based on context
    return policyId;
  },

  // Event handler triggered when any rate limit stage is breached
  onViolation: async (context, decision) => {
    console.warn(
      `[Violation] ${context.ipAddress} exceeded ${decision.bucketId}`,
    );
  },
});
```

### 3. Enforce Rate Limits in API Handlers

Enforce limits directly inside your API routes. You can use RateEngine's built-in framework-agnostic **HTTP Utilities** (`toRateLimitResponse` and `getRateLimitHeaders`) to automatically format RFC-compliant rate limit responses and headers.

If using a serverless platform (like Vercel Edge functions), supply the `waitUntil` parameter to guarantee that Upstash metrics uploads complete properly in the background:

```typescript
// Next.js Route Handler Example
import { type NextRequest, NextResponse } from "next/server";

import { getRateLimitHeaders, toRateLimitResponse } from "rate-engine";

import { rateEngine } from "@/lib/rate-engine";

export async function POST(req: NextRequest, event: { waitUntil: any }) {
  const ip = req.headers.get("x-forwarded-for") ?? "127.0.0.1";

  const decision = await rateEngine.enforce(
    "auth.login",
    {
      ipAddress: ip,
      userId: "user_123",
    },
    {
      // Resolves background metrics promises using serverless hook
      waitUntil: (p) => event.waitUntil(p),
    },
  );

  // 1. If rate limited, return the Web Response directly:
  if (!decision.allowed) {
    return toRateLimitResponse(decision, {
      message: "Custom login error message", // Optional override
      errorCode: "LOGIN_LIMIT_EXCEEDED", // Optional custom error code
    });
  }

  // 2. If allowed, you can append rate limit headers to successful responses:
  const headers = getRateLimitHeaders(decision);

  // Proceed with authentication...
  return NextResponse.json({ success: true }, { headers });
}
```

---

## API Reference

### `RateEngine` Constructor Options

The `RateEngine` class is initialized with an options object:

| Parameter               | Type                                                     | Required | Default      | Description                                                                                                              |
| :---------------------- | :------------------------------------------------------- | :------- | :----------- | :----------------------------------------------------------------------------------------------------------------------- |
| `redis`                 | `RateEngineRedisClient`                                  | Yes      | -            | A duck-typed Redis client instance (e.g., `@upstash/redis` or `ioredis`).                                                |
| `buckets`               | `Record<TBucketId, BucketConfig>`                        | Yes      | -            | Configuration of all available rate limit buckets.                                                                       |
| `policies`              | `Record<TPolicyId, RateLimitPolicy>`                     | Yes      | -            | Rules specifying chained evaluation stages.                                                                              |
| `closedFailurePolicies` | `TPolicyId[] \| Set<TPolicyId>`                          | No       | `Set()`      | Policies that should fail closed (block request) if Redis is degraded.                                                   |
| `logger`                | `RateEngineLogger`                                       | No       | -            | Log utility (e.g., `console` or custom server logger) to track rate limit errors.                                        |
| `redisTimeoutMs`        | `number`                                                 | No       | `1000`       | Redis response timeout in milliseconds before triggering fallbacks.                                                      |
| `fallbackResetMs`       | `number`                                                 | No       | `60000`      | Cooldown/reset duration applied in fallback snapshots when Redis is offline.                                             |
| `bucketPrefixOverrides` | `Partial<Record<TBucketId, string>>`                     | No       | -            | Custom prefix strings mapping to override standard prefix naming rules on a per-bucket basis.                            |
| `resolvePolicy`         | `(policyId, context) => Promise<TPolicyId> \| TPolicyId` | No       | -            | Dynamic resolver hook to redirect requests to alternative policies (e.g. progressive throttling).                        |
| `ephemeralCache`        | `Map<string, number>`                                    | No       | Shared `Map` | An in-memory Map to store local rate limit counts. Set to a custom Map or bypass if you want to customize local caching. |
| `onViolation`           | `(context, decision) => Promise<void> \| void`           | No       | -            | Callback triggered whenever a rate limit is breached or a fail-closed policy fails due to degradation.                   |

---

### Instance Methods

#### 1. `enforce(policyId, context, options?)`

Sequentially evaluates the stages of a rate limit policy.

- **Arguments**:
  - `policyId` (`TPolicyId`): The ID of the policy to enforce.
  - `context` (`TContext`): Execution context representing the actor (IP, user agent, etc.).
  - `options` (`EnforceOptions`): Optional parameters like `{ waitUntil: (p) => void }` for serverless environments.
- **Returns**: `Promise<RateLimitDecision>`

#### 2. `consumeBucket(bucketId, identifier, options?, enforceOptions?)`

Consumes a token from a single bucket (bypassing multi-stage pipelines).

- **Arguments**:
  - `bucketId` (`TBucketId`): The target bucket ID.
  - `identifier` (`string`): Unique identifier (e.g., IP address or user ID).
  - `options` (`ConsumeBucketOptions`): Options like `{ rate: number, context: { ip, userAgent, country }, tier: RateLimitTier }`.
- **Returns**: `Promise<RateLimitDecision>`

#### 3. `readBucket(bucketId, identifier)`

Reads the current remaining tokens of a bucket without consuming one (non-mutating).

- **Arguments**:
  - `bucketId` (`TBucketId`): Target bucket ID.
  - `identifier` (`string`): Unique identifier.
- **Returns**: `Promise<RateLimitSnapshot>`

#### 4. `resetBucket(bucketId, identifier)`

Resets the rate limit tokens consumed for a given bucket/identifier.

- **Arguments**:
  - `bucketId` (`TBucketId`): Target bucket.
  - `identifier` (`string`): Unique identifier.
- **Returns**: `Promise<void>`

#### 5. `getHealth()`

Tests Redis connectivity using `PING` and returns a health status payload.

- **Returns**: `Promise<{ healthy: boolean; usingFallback: boolean; failureCount: number; lastFailure: Date \| null }>`

---

### HTTP Adapters

Framework-agnostic helpers for returning rate limit status to clients.

#### 1. `toRateLimitResponse(decision, options?)`

Creates a standard 429 JSON response.

- **Arguments**:
  - `decision` (`RateLimitDecision`): The decision returned from enforcement.
  - `options` (`{ message?: string, errorCode?: string }`): Customizable body overrides.
- **Returns**: `Response`

#### 2. `toOAuthSlowDownResponse(decision, options?)`

Creates a standard RFC-compliant OAuth 2.0 `slow_down` error response.

- **Arguments**:
  - `decision` (`RateLimitDecision`): Rate limit decision.
  - `options` (`{ message?: string }`): Message description override.
- **Returns**: `Response`

#### 3. `getRateLimitHeaders(decision)`

Builds standard HTTP response headers (e.g. `X-RateLimit-Limit`, `RateLimit-Reset`).

- **Arguments**:
  - `decision` (`{ limit: number, remaining: number, reset: number }`): Current state of rate limiter.
- **Returns**: `Record<string, string>`

---

## Development

To build the source code and generate TS declarations locally:

```bash
bun run build
```

---

## License

MIT © [Christian Paul](https://github.com/cpauldev)
