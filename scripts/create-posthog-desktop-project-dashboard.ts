type PostHogListResponse<T> = {
  results?: T[];
};

type PostHogDashboard = {
  id: number;
  name: string | null;
  description?: string | null;
};

type PostHogInsight = {
  id: number;
  name: string | null;
  dashboards?: number[];
};

type InsightSpec = {
  name: string;
  description: string;
  sql: string;
};

const DASHBOARD_NAME = 'Dhee - Desktop Projects & Location';
const DASHBOARD_DESCRIPTION =
  'Desktop project creation, raw project names, and PostHog GeoIP location coverage.';
const DASHBOARD_TAGS = ['production-analytics'];
const DASHBOARD_PINNED = true;

const INSIGHTS: InsightSpec[] = [
  {
    name: 'Projects Created, Last 30 Days',
    description: 'Total desktop project_created events in the last 30 days.',
    sql: `
SELECT count() AS projects_created_30d
FROM events
WHERE event = 'project_created'
  AND timestamp >= now() - INTERVAL 30 DAY
`.trim(),
  },
  {
    name: 'Unique Project Creators, Last 30 Days',
    description: 'Unique desktop identities that created at least one project.',
    sql: `
SELECT count(DISTINCT distinct_id) AS unique_project_creators_30d
FROM events
WHERE event = 'project_created'
  AND timestamp >= now() - INTERVAL 30 DAY
`.trim(),
  },
  {
    name: 'Projects Created By Day',
    description: 'Daily project creation trend for the last 30 days.',
    sql: `
SELECT
  toStartOfDay(timestamp) AS day,
  count() AS projects_created,
  count(DISTINCT distinct_id) AS creators
FROM events
WHERE event = 'project_created'
  AND timestamp >= now() - INTERVAL 30 DAY
GROUP BY day
ORDER BY day WITH FILL
  FROM toStartOfDay(now() - INTERVAL 30 DAY)
  TO toStartOfDay(now())
  STEP INTERVAL 1 DAY
`.trim(),
  },
  {
    name: 'Recent Desktop Project Names',
    description: 'Recent raw desktop project names with coarse GeoIP context.',
    sql: `
SELECT
  timestamp,
  distinct_id,
  properties.project_name AS project_name,
  properties.project_name_length AS project_name_length,
  properties.$geoip_country_name AS country,
  properties.$geoip_subdivision_1_name AS region,
  properties.$geoip_city_name AS city,
  properties.app_version AS app_version
FROM events
WHERE event = 'project_created'
  AND timestamp >= now() - INTERVAL 30 DAY
ORDER BY timestamp DESC
LIMIT 100
`.trim(),
  },
  {
    name: 'Projects By Country, Region, And City',
    description: 'Project creation grouped by PostHog GeoIP fields.',
    sql: `
SELECT
  coalesce(toString(properties.$geoip_country_name), 'Unknown') AS country,
  coalesce(toString(properties.$geoip_subdivision_1_name), 'Unknown') AS region,
  coalesce(toString(properties.$geoip_city_name), 'Unknown') AS city,
  count() AS projects_created,
  count(DISTINCT distinct_id) AS creators
FROM events
WHERE event = 'project_created'
  AND timestamp >= now() - INTERVAL 30 DAY
GROUP BY country, region, city
ORDER BY projects_created DESC
LIMIT 100
`.trim(),
  },
  {
    name: 'Project Name Coverage QA',
    description: 'Checks whether project_created carries raw project_name.',
    sql: `
SELECT
  count() AS total_project_created_events,
  countIf(properties.project_name IS NOT NULL) AS with_project_name,
  round(
    with_project_name * 100.0 / nullIf(total_project_created_events, 0),
    2
  ) AS project_name_coverage_percent
FROM events
WHERE event = 'project_created'
  AND timestamp >= now() - INTERVAL 7 DAY
`.trim(),
  },
  {
    name: 'Desktop Project GeoIP Coverage QA',
    description: 'Checks whether PostHog GeoIP enrichment is present.',
    sql: `
SELECT
  count() AS total_project_created_events,
  countIf(properties.$geoip_country_name IS NOT NULL) AS with_geoip_country,
  countIf(properties.$geoip_subdivision_1_name IS NOT NULL) AS with_geoip_region,
  countIf(properties.$geoip_city_name IS NOT NULL) AS with_geoip_city,
  round(
    with_geoip_country * 100.0 / nullIf(total_project_created_events, 0),
    2
  ) AS geoip_country_coverage_percent
FROM events
WHERE event = 'project_created'
  AND timestamp >= now() - INTERVAL 7 DAY
`.trim(),
  },
];

function isDryRun(): boolean {
  return process.argv.includes('--dry-run');
}

function apiHost(): string {
  return (process.env.POSTHOG_API_HOST || 'https://us.posthog.com').replace(
    /\/+$/,
    '',
  );
}

function requiredEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : null;
}

function insightPayload(spec: InsightSpec, dashboardId: number | string) {
  return {
    name: spec.name,
    description: spec.description,
    dashboards: [dashboardId],
    tags: DASHBOARD_TAGS,
    query: {
      kind: 'InsightVizNode',
      source: {
        kind: 'HogQLQuery',
        query: spec.sql,
      },
    },
  };
}

function dryRunPayload() {
  return {
    dashboard: {
      name: DASHBOARD_NAME,
      description: DASHBOARD_DESCRIPTION,
      tags: DASHBOARD_TAGS,
      pinned: DASHBOARD_PINNED,
    },
    insights: INSIGHTS.map((spec) => insightPayload(spec, '<dashboard-id>')),
  };
}

async function posthogRequest<T>(
  path: string,
  options: {
    method?: 'GET' | 'POST' | 'PATCH';
    body?: unknown;
    apiKey: string;
  },
): Promise<T> {
  const response = await fetch(`${apiHost()}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const method = options.method ?? 'GET';
    throw new Error(
      `${method} ${path} failed with ${response.status}: ${text.slice(
        0,
        500,
      )}`,
    );
  }

  return (await response.json()) as T;
}

async function findDashboard(
  apiKey: string,
  environmentId: string,
): Promise<PostHogDashboard | null> {
  const result = await posthogRequest<PostHogListResponse<PostHogDashboard>>(
    `/api/environments/${environmentId}/dashboards/?search=${encodeURIComponent(
      DASHBOARD_NAME,
    )}`,
    { apiKey },
  );
  return (
    result.results?.find((dashboard) => dashboard.name === DASHBOARD_NAME) ??
    null
  );
}

async function ensureDashboard(
  apiKey: string,
  environmentId: string,
): Promise<PostHogDashboard> {
  const existing = await findDashboard(apiKey, environmentId);
  const body = {
    name: DASHBOARD_NAME,
    description: DASHBOARD_DESCRIPTION,
    tags: DASHBOARD_TAGS,
    pinned: DASHBOARD_PINNED,
  };

  if (existing) {
    return posthogRequest<PostHogDashboard>(
      `/api/environments/${environmentId}/dashboards/${existing.id}/`,
      {
        apiKey,
        method: 'PATCH',
        body,
      },
    );
  }

  return posthogRequest<PostHogDashboard>(
    `/api/environments/${environmentId}/dashboards/`,
    {
      apiKey,
      method: 'POST',
      body,
    },
  );
}

async function findInsight(
  apiKey: string,
  environmentId: string,
  name: string,
): Promise<PostHogInsight | null> {
  const result = await posthogRequest<PostHogListResponse<PostHogInsight>>(
    `/api/environments/${environmentId}/insights/?search=${encodeURIComponent(
      name,
    )}`,
    { apiKey },
  );
  return result.results?.find((insight) => insight.name === name) ?? null;
}

async function ensureInsight(
  apiKey: string,
  environmentId: string,
  dashboardId: number,
  spec: InsightSpec,
): Promise<PostHogInsight> {
  const existing = await findInsight(apiKey, environmentId, spec.name);
  const dashboards = Array.from(
    new Set([...(existing?.dashboards ?? []), dashboardId]),
  );
  const body = {
    ...insightPayload(spec, dashboardId),
    dashboards,
  };

  if (existing) {
    return posthogRequest<PostHogInsight>(
      `/api/environments/${environmentId}/insights/${existing.id}/`,
      {
        apiKey,
        method: 'PATCH',
        body,
      },
    );
  }

  return posthogRequest<PostHogInsight>(
    `/api/environments/${environmentId}/insights/`,
    {
      apiKey,
      method: 'POST',
      body,
    },
  );
}

async function main(): Promise<void> {
  if (isDryRun()) {
    console.log(JSON.stringify(dryRunPayload(), null, 2));
    return;
  }

  const apiKey = requiredEnv('POSTHOG_PERSONAL_API_KEY');
  const environmentId = requiredEnv('POSTHOG_PROJECT_ID');

  if (!apiKey || !environmentId) {
    console.log(
      [
        'PostHog dashboard provisioning skipped.',
        'Set POSTHOG_PERSONAL_API_KEY and POSTHOG_PROJECT_ID to create or update the dashboard.',
        `Optional: set POSTHOG_API_HOST if your PostHog app host is not ${apiHost()}.`,
        'Use --dry-run to print the dashboard payload without credentials.',
      ].join('\n'),
    );
    return;
  }

  const dashboard = await ensureDashboard(apiKey, environmentId);
  console.log(`Dashboard ready: ${DASHBOARD_NAME} (${dashboard.id})`);

  for (const spec of INSIGHTS) {
    const insight = await ensureInsight(
      apiKey,
      environmentId,
      dashboard.id,
      spec,
    );
    console.log(`Insight ready: ${insight.name ?? spec.name} (${insight.id})`);
  }
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
