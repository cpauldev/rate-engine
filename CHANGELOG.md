# Changelog

All notable changes to this project will be documented in this file.

## [0.2.0] - 2026-06-24

This release improves fail-closed safety, composite quota reporting, health telemetry, public type organization, and package documentation.

### Added

- Added `failureMode?: "open" | "closed"` to `ConsumeBucketOptions`. Direct `consumeBucket()` calls still fail open by default, but sensitive direct bucket checks can now fail closed on Redis errors.
- Added `effective` metadata to `RateLimitDecision` so callers can see which buckets contributed the root `limit`, `remaining`, and `reset` values.
- Added `stages` to policy enforcement decisions so callers can inspect every evaluated stage in the policy path.
- Added stateful health telemetry for Redis operations: `consecutiveFailures`, `totalFailures`, `lastFailure`, and `lastSuccess`.
- Added `resetHealth()` to clear stateful health telemetry in tests or operational tooling.
- Added `analytics?: boolean` to `RateEngineOptions`, defaulting to `true`, so consumers can opt out of `@upstash/ratelimit` analytics uploads.
- Added a complete package test suite covering engine behavior, real limiter construction fallback behavior, HTTP helpers, public exports, composite quota metadata, empty policies, health telemetry, and violation hook payloads.

### Changed

- Changed successful multi-stage `enforce()` responses to return conservative root quota metrics: lowest `remaining`, the `limit` from that same stage, and the latest `reset` timestamp across evaluated stages.
- Changed `onViolation` payloads to include the evaluated `stages` path when a policy stage blocks or a fail-closed degradation blocks.
- Moved `ConsumeBucketOptions`, `EnforceOptions`, and `RateEngineOptions` into `src/types.ts` so public types are exported from one source.
- Split single-stage decision shape into `RateLimitStageDecision` and final decision shape into `RateLimitDecision`, avoiding recursive `stages` typing.
- Updated README language to describe Redis compatibility by required commands (`eval`, `evalsha`, `incr`, `expire`, `ping`) instead of broad backend support claims.
- Updated `resetBucket()` documentation to clarify that successful bucket resets record connectivity health but do not replace `resetHealth()`.
- Clarified that root quota fields in multi-stage decisions are conservative client-facing values and may be composite.
- Clarified that health telemetry is process-local to the current `RateEngine` instance.
- Added `CHANGELOG.md` to the package publication files.
- Added package-local `test`, source/test `typecheck`, and built-dist smoke test scripts.

### Fixed

- Throws `[RateEngine] Policy has no stages defined` before aggregating an empty policy, avoiding a reduction failure with less helpful diagnostics.
- Missing bucket configuration now surfaces as a developer configuration error instead of being converted into a degraded fail-open fallback decision.

### Removed

- Removed the completed internal `PLAN.md` from the package directory.

## [0.1.0] - 2026-06-23

Initial release of `RateEngine`, a client-agnostic, multi-stage rate limiting policy engine for TypeScript powered by `@upstash/ratelimit`.

### Added

- Added the generic `RateEngine` class with typed policy IDs, bucket IDs, and request context.
- Added Redis-backed bucket consumption through `@upstash/ratelimit` with sliding window, fixed window, and token bucket support.
- Added ordered multi-stage policy enforcement with short-circuiting on the first blocked stage.
- Added default fail-open fallback behavior for Redis errors, returning degraded decisions instead of throwing from bucket consumption.
- Added policy-level fail-closed support through per-policy `failureMode` and `closedFailurePolicies`.
- Added dynamic policy resolution through `resolvePolicy`.
- Added `onViolation` telemetry hook for blocked requests and fail-closed degradation blocks.
- Added `waitUntil` propagation for `@upstash/ratelimit` background analytics promises.
- Added bucket read and reset helpers: `readBucket()` and `resetBucket()`.
- Added health checks through `getHealth()`.
- Added HTTP helpers: `getRateLimitHeaders()`, `toRateLimitResponse()`, and `toOAuthSlowDownResponse()`.
