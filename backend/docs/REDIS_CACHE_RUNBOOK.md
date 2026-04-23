# Redis & HTTP cache — Operational Runbook

**Stellar Wave batch · SW-BE-007**  
Covers the NestJS Redis layer at `backend/src/modules/redis/`, HTTP cache interceptors, rate limiting, health checks, and related observability.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Environment Variables](#2-environment-variables)
3. [Key Namespaces & TTLs](#3-key-namespaces--ttls)
4. [HTTP Caching](#4-http-caching)
5. [Rate Limiting](#5-rate-limiting)
6. [Observability — Prometheus metrics](#6-observability--prometheus-metrics)
7. [Health Checks](#7-health-checks)
8. [Incident Playbooks](#8-incident-playbooks)
9. [Cache Invalidation & Emergency Flush](#9-cache-invalidation--emergency-flush)
10. [Security & Logging](#10-security--logging)
11. [Graceful Shutdown](#11-graceful-shutdown)
12. [Rollback Procedure](#12-rollback-procedure)
13. [Migration Notes](#13-migration-notes)

---

## 1. Architecture Overview

**Components**

| Component | Role |
|-----------|------|
| `RedisModule` | Registers `cache-manager` with `cache-manager-ioredis-yet` (store-backed cache). |
| `RedisService` | Direct `ioredis` client for sessions/rate limits/pattern deletes; wraps cache get/set/del. |
| `HealthController` | `GET /health/redis` — smoke test via cache set/get. |
| `RedisRateLimitGuard` | Per-IP/route counters in Redis. |
| `CacheInterceptor` / `AdvancedCacheInterceptor` | Optional HTTP response caching via `RedisService`. |
| `GracefulShutdownService` | Closes the raw Redis client on process shutdown. |
| `JobsModule` (BullMQ) | Separate connection using the same `REDIS_HOST`, `REDIS_PORT`, and `REDIS_PASSWORD` (see `jobs.module.ts`). |

**Data flow (simplified)**

```
Config (REDIS_*) → RedisModule / RedisService → ioredis + cache-manager
Auth refresh tokens → Redis keys refresh_token:{userId}
Rate limits → Redis keys rate_limit:{ip}:{route}
HTTP cache → keys produced by interceptors (often prefixed cache:)
```

---

## 2. Environment Variables

Validated in `src/config/env.validation.ts` and loaded via `src/config/redis.config.ts` (`registerAs('redis', …)`).

| Variable | Purpose |
|----------|---------|
| `REDIS_HOST` | Redis server hostname. |
| `REDIS_PORT` | Redis TCP port (default `6379`). |
| `REDIS_PASSWORD` | Optional auth string; use secrets manager in production — **never commit or log**. |
| `REDIS_DB` | Logical database index (default `0`). |
| `REDIS_TTL` | Default HTTP cache TTL in **seconds** for the cache-manager store (default `300`). |

Local reference values live in `.env.example` (placeholders only, no production secrets).

---

## 3. Key Namespaces & TTLs

| Prefix / pattern | Used for | Typical TTL |
|------------------|----------|-------------|
| `refresh_token:{userId}` | Refresh token material for auth flows | Service default `604800` s (7 days) unless overridden in code |
| `rate_limit:{ip}:{path}` | `RedisRateLimitGuard` counters | Decorator `ttl` (often 60 s) |
| `cache:*` | HTTP cache entries from interceptors; `RedisService.reset()` targets this prefix | Often `300` s or per-handler options |
| `health-check` | Ephemeral key for `/health/redis` | `10` s in controller |

Operational note: `RedisService.delByPattern` and `reset()` use Redis `KEYS`, which is **O(N)** and can block a busy instance. Prefer maintenance windows or targeted `DEL` for production incidents.

---

## 4. HTTP Caching

- **`CacheInterceptor`** builds keys like `cache:{method}:{url}:{userId|anonymous}:{JSON.stringify(query)}` and caches GET responses (fixed TTL in interceptor code).
- **`AdvancedCacheInterceptor`** respects handler metadata from `@CacheOptions` and honors header **`x-cache-bypass: true`** to skip the cache for a request.

---

## 5. Rate Limiting

- Guard: `RedisRateLimitGuard` with `@RateLimit(limit, ttl)` metadata.
- If Redis errors during increment, the service returns `0` for the counter so requests are **not** blocked (fail-open). Monitor `tycoon_redis_errors_total` when relying on strict limits.

---

## 6. Observability — Prometheus metrics

Counters and histograms registered in `RedisService` (names are stable contracts for dashboards):

- `tycoon_redis_operations_total` — labels: `operation` (e.g. `set_refresh_token`, `cache_get`, `increment_rate_limit`, …).
- `tycoon_redis_operation_duration_seconds` — histogram by `operation`.
- `tycoon_redis_errors_total` — labels: `operation`.
- `tycoon_redis_connections_total` — gauge (`1` connected, `0` disconnected).
- `tycoon_cache_hits_total`
- `tycoon_cache_misses_total`

---

## 7. Health Checks

- **Endpoint:** `GET /health/redis` (excluded from the versioned `api` prefix — same pattern as `/metrics`).
- **Behavior:** Sets a short-lived `health-check` key via `RedisService`, reads it back, returns JSON with `status: healthy` and `redis: connected` on success.
- **Failure:** `status: unhealthy`, `redis: disconnected`, and a non-sensitive `error` message string (no passwords).

---

## 8. Incident Playbooks

### 8.1 Redis connection refused / timeouts

1. Confirm process reachability: `redis-cli -h $REDIS_HOST -p $REDIS_PORT ping` (from the same network as the API).
2. Verify `REDIS_HOST`, `REDIS_PORT`, firewall, and K8s `Service` endpoints.
3. Check application logs for `Redis connection error` (message only — no credentials).
4. Review `tycoon_redis_errors_total` and `tycoon_redis_connections_total`.

### 8.2 AUTH errors after Redis password rotation

1. Update the secret store / deployment env for **`REDIS_PASSWORD`** only (no code change if the variable name is unchanged).
2. Rolling-restart API pods so every instance picks up the new password.
3. BullMQ workers (`JobsModule`) share `REDIS_PASSWORD` — restart workers if they run in separate processes.

### 8.3 Elevated cache miss rate or stale data

1. Confirm upstream API or DB actually changed (stale cache vs real drift).
2. For advanced cache, verify clients are not accidentally sending `x-cache-bypass: true`.
3. If a bad payload was cached, delete known keys or use a controlled invalidation path (`del` / `delByPattern` with care — see section 9).

### 8.4 Wrong logical database (`REDIS_DB`)

Symptoms: empty cache, missing tokens, or collisions with another service using the same Redis.

1. Align `REDIS_DB` with the intended index across **all** services sharing that Redis (cache-manager, `RedisService` raw client, and any tooling).
2. Restart the API after changing `REDIS_DB`.

---

## 9. Cache Invalidation & Emergency Flush

- **Single key:** use application APIs that call `RedisService.del` where available, or `redis-cli DEL <key>` in controlled maintenance.
- **Pattern / full app cache prefix:** `delByPattern` / `reset()` — use sparingly in production due to `KEYS` cost; prefer low-traffic windows.
- **Nuclear option:** `FLUSHDB` / `FLUSHALL` on the server — only with explicit change approval; impacts every key in that DB index (including BullMQ if sharing the same `REDIS_DB`).

---

## 10. Security & Logging

- **Never** print `REDIS_PASSWORD`, refresh token values, or full cache payloads in logs, tickets, or runbook copies.
- Application code should log **identifiers** (e.g. user id, cache key name) and **error messages** only; `RedisService` does not log the password field.
- Restrict Redis network access to application subnets and bastion hosts.

---

## 11. Graceful Shutdown

On SIGTERM / SIGINT, `GracefulShutdownService` pauses BullMQ queues (when configured), closes the TypeORM pool, then calls **`RedisService.quit()`** to close the `ioredis` connection cleanly. Ensure `SHUTDOWN_TIMEOUT_MS` remains below the orchestrator termination grace period (see `.env.example`).

---

## 12. Rollback Procedure

1. Revert the deployment to the previous container image / chart revision.
2. No database migrations are tied to Redis configuration — rollback is **configuration + binary** only.
3. If a bad `REDIS_TTL` or cache key shape shipped, reverting code restores prior caching behavior; cached entries from the old version expire naturally by TTL unless you explicitly purge keys.

---

## 13. Migration Notes

**SW-BE-007** is documentation and contract tests only: **backward-compatible** with existing deployments.

- **Feature flags:** None — Redis remains required for refresh-token storage, rate limiting, and cache-manager-backed features as today.
- **Rollout:** Merge runbook + tests; no env var renames and no schema migrations.
- **Post-deploy:** Spot-check `GET /health/redis` and Grafana panels wired to the metric names in section 6.

---

*Last updated: SW-BE-007 · Stellar Wave batch*
