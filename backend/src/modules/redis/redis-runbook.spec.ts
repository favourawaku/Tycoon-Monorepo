/**
 * SW-BE-007: Redis & cache layer — operational runbooks
 *
 * Runbook contract tests — ensure docs/REDIS_CACHE_RUNBOOK.md stays aligned
 * with env validation, Redis configuration, metrics, and critical code paths.
 * Pure static/unit checks — no Redis, no HTTP, no I/O beyond reading files.
 */

import * as fs from 'fs';
import * as path from 'path';

const root = path.resolve(__dirname, '../../..');

function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(root, 'src', relPath), 'utf8');
}

function readDoc(relPath: string): string {
  return fs.readFileSync(path.join(root, relPath), 'utf8');
}

describe('Runbook contract: environment variables (SW-BE-007)', () => {
  const runbook = readDoc('docs/REDIS_CACHE_RUNBOOK.md');
  const envExample = readDoc('.env.example');
  const validationSrc = readSrc('config/env.validation.ts');

  const redisEnvVars = [
    'REDIS_HOST',
    'REDIS_PORT',
    'REDIS_PASSWORD',
    'REDIS_DB',
    'REDIS_TTL',
  ];

  redisEnvVars.forEach((varName) => {
    it(`runbook documents env var "${varName}"`, () => {
      expect(runbook).toContain(varName);
    });

    it(`".env.example" contains "${varName}"`, () => {
      expect(envExample).toContain(varName);
    });

    it(`env.validation.ts references "${varName}"`, () => {
      expect(validationSrc).toContain(varName);
    });
  });
});

describe('Runbook contract: Prometheus metrics (SW-BE-007)', () => {
  const runbook = readDoc('docs/REDIS_CACHE_RUNBOOK.md');
  const redisServiceSrc = readSrc('modules/redis/redis.service.ts');

  const metricNames = [
    'tycoon_redis_operations_total',
    'tycoon_redis_operation_duration_seconds',
    'tycoon_redis_errors_total',
    'tycoon_redis_connections_total',
    'tycoon_cache_hits_total',
    'tycoon_cache_misses_total',
  ];

  metricNames.forEach((name) => {
    it(`RedisService registers "${name}"`, () => {
      expect(redisServiceSrc).toContain(name);
    });

    it(`runbook documents "${name}"`, () => {
      expect(runbook).toContain(name);
    });
  });
});

describe('Runbook contract: key namespaces (SW-BE-007)', () => {
  const runbook = readDoc('docs/REDIS_CACHE_RUNBOOK.md');
  const redisServiceSrc = readSrc('modules/redis/redis.service.ts');
  const rateLimitGuardSrc = readSrc('common/guards/redis-rate-limit.guard.ts');
  const cacheInterceptorSrc = readSrc('common/interceptors/cache.interceptor.ts');

  const keyFragments = [
    'refresh_token:',
    'rate_limit:',
    'cache:',
  ];

  keyFragments.forEach((frag) => {
    it(`runbook documents key fragment "${frag}"`, () => {
      expect(runbook).toContain(frag);
    });
  });

  it('RedisService uses refresh_token prefix', () => {
    expect(redisServiceSrc).toContain('refresh_token:');
  });

  it('RedisRateLimitGuard uses rate_limit prefix', () => {
    expect(rateLimitGuardSrc).toContain('rate_limit:');
  });

  it('CacheInterceptor uses cache: prefix in keys', () => {
    expect(cacheInterceptorSrc).toContain('cache:');
  });
});

describe('Runbook contract: health & shutdown wiring (SW-BE-007)', () => {
  const runbook = readDoc('docs/REDIS_CACHE_RUNBOOK.md');
  const healthSrc = readSrc('health/health.controller.ts');
  const shutdownSrc = readSrc('common/shutdown/graceful-shutdown.service.ts');

  it('runbook documents GET /health/redis', () => {
    expect(runbook).toContain('GET /health/redis');
  });

  it('HealthController probes health-check key', () => {
    expect(healthSrc).toContain('health-check');
  });

  it('runbook mentions GracefulShutdownService', () => {
    expect(runbook).toContain('GracefulShutdownService');
  });

  it('GracefulShutdownService calls redisService.quit', () => {
    expect(shutdownSrc).toContain('await this.redisService.quit()');
  });
});

describe('Runbook self-consistency (SW-BE-007)', () => {
  const runbook = readDoc('docs/REDIS_CACHE_RUNBOOK.md');

  const requiredSections = [
    'Architecture Overview',
    'Environment Variables',
    'Key Namespaces',
    'HTTP Caching',
    'Rate Limiting',
    'Prometheus metrics',
    'Health Checks',
    'Incident Playbooks',
    'Cache Invalidation',
    'Security & Logging',
    'Graceful Shutdown',
    'Rollback Procedure',
    'Migration Notes',
  ];

  requiredSections.forEach((section) => {
    it(`runbook contains "${section}"`, () => {
      expect(runbook).toContain(section);
    });
  });

  it('runbook references SW-BE-007', () => {
    expect(runbook).toContain('SW-BE-007');
  });

  it('runbook documents BullMQ shared connection note', () => {
    expect(runbook).toContain('BullMQ');
  });

  it('runbook does not embed a fake long Redis password', () => {
    expect(runbook).not.toMatch(/REDIS_PASSWORD\s*=\s*[a-fA-F0-9]{32,}/);
  });
});
