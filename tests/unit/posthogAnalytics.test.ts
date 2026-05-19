import { beforeEach, describe, expect, it, vi } from 'vitest';

const posthogMocks = vi.hoisted(() => ({
  capture: vi.fn(),
  identify: vi.fn(),
  shutdown: vi.fn(),
  constructor: vi.fn(),
}));

vi.mock('posthog-node', () => ({
  PostHog: vi.fn().mockImplementation((apiKey: string, opts: unknown) => {
    posthogMocks.constructor(apiKey, opts);
    return {
      capture: posthogMocks.capture,
      identify: posthogMocks.identify,
      shutdown: posthogMocks.shutdown,
    };
  }),
}));

import {
  captureDesktopAppStarted,
  configurePostHogRuntime,
  configureAnalytics,
  identifyAnalyticsUser,
  resetAnalyticsForTests,
  sanitizeAnalyticsProperties,
  setAnalyticsIdentity,
} from '../../src/server/posthog.js';

describe('posthog analytics', () => {
  beforeEach(() => {
    delete process.env.POSTHOG_API_KEY;
    delete process.env.POSTHOG_HOST;
    posthogMocks.capture.mockClear();
    posthogMocks.identify.mockClear();
    posthogMocks.shutdown.mockClear();
    posthogMocks.constructor.mockClear();
    resetAnalyticsForTests();
  });

  it('no-ops when PostHog is not configured', () => {
    captureDesktopAppStarted();

    expect(posthogMocks.constructor).not.toHaveBeenCalled();
    expect(posthogMocks.capture).not.toHaveBeenCalled();
  });

  it('uses install identity first and user identity after identify', () => {
    process.env.POSTHOG_API_KEY = 'phc_test';
    configureAnalytics({
      platform: 'desktop',
      appVersion: '1.2.3',
      identity: { installId: 'install-1' },
    });

    captureDesktopAppStarted({ source: 'test' });
    expect(posthogMocks.capture).toHaveBeenLastCalledWith(
      expect.objectContaining({
        distinctId: 'install:install-1',
        event: 'desktop_app_started',
        properties: expect.objectContaining({
          app_component: 'dhee-desktop',
          app_version: '1.2.3',
          install_id: 'install-1',
          source: 'test',
        }),
      }),
    );

    identifyAnalyticsUser({ installId: 'install-1', userId: 'user-1' });
    expect(posthogMocks.identify).toHaveBeenCalledWith(
      expect.objectContaining({
        distinctId: 'user:user-1',
        properties: expect.objectContaining({
          user_id: 'user-1',
          install_id: 'install-1',
          $anon_distinct_id: 'install:install-1',
        }),
      }),
    );

    captureDesktopAppStarted();
    expect(posthogMocks.capture).toHaveBeenLastCalledWith(
      expect.objectContaining({
        distinctId: 'user:user-1',
        event: 'desktop_app_started',
      }),
    );

    setAnalyticsIdentity({ installId: 'install-1' });
    captureDesktopAppStarted();
    expect(posthogMocks.capture).toHaveBeenLastCalledWith(
      expect.objectContaining({
        distinctId: 'install:install-1',
        event: 'desktop_app_started',
        properties: expect.not.objectContaining({
          user_id: 'user-1',
        }),
      }),
    );
  });

  it('can enable PostHog after an early disabled check', () => {
    captureDesktopAppStarted();
    expect(posthogMocks.constructor).not.toHaveBeenCalled();

    configurePostHogRuntime({
      apiKey: 'phc_runtime',
      host: 'https://posthog.test',
      analyticsSalt: 'salt-1',
    });
    captureDesktopAppStarted({ source: 'runtime-config' });

    expect(process.env.ANALYTICS_SALT).toBe('salt-1');
    expect(posthogMocks.constructor).toHaveBeenCalledWith('phc_runtime', {
      host: 'https://posthog.test',
    });
    expect(posthogMocks.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'desktop_app_started',
        properties: expect.objectContaining({
          source: 'runtime-config',
        }),
      }),
    );
  });

  it('removes sensitive property keys before capture', () => {
    const sanitized = sanitizeAnalyticsProperties({
      ok: 'value',
      apiKey: 'secret',
      nested: {
        token: 'secret',
        count: 2,
      },
    });

    expect(sanitized).toEqual({
      ok: 'value',
      nested: { count: 2 },
    });
  });
});
