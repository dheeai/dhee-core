# PostHog Production Dashboards

This runbook defines the PostHog dashboards Dhee should have before production.
It assumes the current analytics event contract:

- Website pageviews use `$pageview` with `$session_id`, `$current_url`, `$pathname`, and `$referrer`.
- Website downloads use `website_download_clicked`.
- Desktop launches use `desktop_app_started`, with first launch tracked as `desktop_app_first_started`.
- Desktop live activity uses `desktop_heartbeat`.
- Desktop screen/session activity uses `$screen` with `$screen_name = 'desktop_main'`.
- Desktop project creation uses `project_created` with raw `project_name`,
  `project_name_length`, `creation_surface`, and `project_creation_source`.
- Core runtime sessions use `core_session_started` and `core_session_ended`.
- Core work uses `core_task_started`, `core_task_completed`, `core_task_failed`, `core_tool_call_started`, and `core_tool_call_completed`.
- Completed full length output uses `final_video_created`.

PostHog SQL insights query the `events` table directly. PostHog's SQL docs show
that common fields include `event`, `timestamp`, `properties`, `person_id`, and
`distinct_id`, and that event properties can be accessed with dot notation such
as `properties.$current_url`.

References:

- PostHog SQL editor: https://posthog.com/docs/data-warehouse/sql
- PostHog dashboards: https://posthog.com/docs/product-analytics/dashboards
- PostHog dashboards API: https://posthog.com/docs/api/dashboards
- PostHog insights API: https://posthog.com/docs/api/insights

## Setup

Create these dashboards in PostHog:

1. `Dhee - Production Overview`
2. `Dhee - Activation Funnel`
3. `Dhee - Desktop Live Health`
4. `Dhee - Video Creation`
5. `Dhee - Desktop Projects & Location`
6. `Dhee - Analytics QA`

For each query below:

1. Go to PostHog > Product analytics > SQL.
2. Paste the query.
3. Save it as an insight with the suggested tile name.
4. Add it to the dashboard named in the section.

The `Dhee - Desktop Projects & Location` dashboard can also be provisioned
through the PostHog API. It is pinned and uses the same
`production-analytics` tag as the existing production dashboards:

```bash
POSTHOG_PERSONAL_API_KEY=... POSTHOG_PROJECT_ID=... pnpm analytics:dashboard:posthog
```

Use `pnpm analytics:dashboard:posthog --dry-run` to print the dashboard payload
without credentials. The script uses `POSTHOG_API_HOST`, defaulting to
`https://us.posthog.com`.

Use the `Filter out internal and test users` control in PostHog while viewing
dashboards. For SQL tiles that must respect dashboard filters or date overrides,
include `{filters}` in the `WHERE` clause. The fixed-window production KPI
queries below intentionally use explicit time windows like `INTERVAL 30 DAY` so
the numbers stay stable regardless of the selected dashboard date range.

## Visualization Layer

Use raw SQL tables for exact KPI counts, reconciliation, and analytics QA. Use
native PostHog trend charts for product and executive dashboards so the default
view is visual and scannable.

Recommended chart tiles:

- `Dhee - Production Overview`: `Desktop Active Users Trend`, `Desktop Launches By Day`, `Desktop Event Mix Last 24 Hours`, `Core Activity Mix Last 24 Hours`, `Video Creation Trend`
- `Dhee - Activation Funnel`: `Downloads By Platform Pie`, `Downloads Trend By Day`, `Website Pageviews Trend`, `Desktop First Starts Trend`
- `Dhee - Desktop Live Health`: `Desktop Heartbeats By Hour`, `Desktop Starts By Version`, `Desktop Session Event Mix`
- `Dhee - Video Creation`: `Videos Created By Day Chart`, `Task Outcome Pie`, `Core Tasks By Workflow`, `Tool Calls By Tool`, `Failed Workflows By Name`
- `Dhee - Desktop Projects & Location`: `Projects Created By Day`, `Projects By Country`, `Projects By Region`, `Recent Project Names`
- `Dhee - Analytics QA`: `Analytics Event Volume Last 24 Hours`, `Legacy Website Events Trend`, `Analytics Event Mix Pie`

Keep the visual tiles above the raw SQL tables on each dashboard. The first row
should answer the dashboard's main question at a glance, and the SQL tables
should support drill-down or data-quality checks.

## Dashboard 1: Dhee - Production Overview

This is the main executive dashboard. It answers the questions we need at any
point in time.

### Unique Desktop Starters Ever

Ground truth for "how many different people/installations have started Dhee
Studio at least once."

```sql
SELECT count(DISTINCT distinct_id) AS unique_desktop_starters
FROM events
WHERE event = 'desktop_app_first_started'
```

### Website Downloaders Ever

```sql
SELECT count(DISTINCT distinct_id) AS unique_downloaders
FROM events
WHERE event = 'website_download_clicked'
```

### Downloaded And Started, Same Identity

This is only reliable when web and desktop identities merge through sign-in.
Before sign-in, the website anonymous ID and desktop install ID are different
identities.

```sql
SELECT count(DISTINCT starter.distinct_id) AS downloaded_and_started
FROM
  (
    SELECT DISTINCT distinct_id
    FROM events
    WHERE event = 'desktop_app_first_started'
  ) AS starter
INNER JOIN
  (
    SELECT DISTINCT distinct_id
    FROM events
    WHERE event = 'website_download_clicked'
  ) AS downloader
ON starter.distinct_id = downloader.distinct_id
```

### Desktop Users In Last 30 Days

Counts anyone who launched the desktop, sent a heartbeat, or did core work in
the last 30 days.

```sql
SELECT count(DISTINCT distinct_id) AS desktop_users_30d
FROM events
WHERE timestamp >= now() - INTERVAL 30 DAY
  AND event IN (
    'desktop_app_started',
    'desktop_heartbeat',
    'project_created',
    'core_session_started',
    'core_task_started',
    'final_video_created'
  )
```

### Desktop Use Frequency, Last 30 Days

"Used more than 2, 5, 10 times" is defined as desktop launches via
`desktop_app_started`.

```sql
SELECT
  countIf(launches > 2) AS users_more_than_2_launches,
  countIf(launches > 5) AS users_more_than_5_launches,
  countIf(launches > 10) AS users_more_than_10_launches
FROM
  (
    SELECT distinct_id, count() AS launches
    FROM events
    WHERE event = 'desktop_app_started'
      AND timestamp >= now() - INTERVAL 30 DAY
    GROUP BY distinct_id
  )
```

### Active Desktop Users Now

Heartbeat interval is currently one minute. A two-minute window tolerates one
late heartbeat.

```sql
SELECT count(DISTINCT distinct_id) AS active_desktop_users_now
FROM events
WHERE event = 'desktop_heartbeat'
  AND timestamp >= now() - INTERVAL 2 MINUTE
```

### Active Desktop Sessions Now

```sql
SELECT count(DISTINCT properties.$session_id) AS active_desktop_sessions_now
FROM events
WHERE event = 'desktop_heartbeat'
  AND timestamp >= now() - INTERVAL 2 MINUTE
  AND properties.$session_id IS NOT NULL
```

### Full Length Videos Created Ever

```sql
SELECT count() AS full_length_videos_created
FROM events
WHERE event = 'final_video_created'
```

### Full Length Videos Created, Last 30 Days

```sql
SELECT count() AS full_length_videos_created_30d
FROM events
WHERE event = 'final_video_created'
  AND timestamp >= now() - INTERVAL 30 DAY
```

## Dashboard 2: Dhee - Activation Funnel

Use PostHog's Funnel insight UI for the main funnel:

1. `website_page_viewed` should not be used for new production analytics.
2. Step 1: `$pageview`
3. Step 2: `website_download_clicked`
4. Step 3: `desktop_auth_started`
5. Step 4: `desktop_token_issued`
6. Step 5: `desktop_app_first_started`

Break down by `platform` on the download step where available.

Important caveat: anonymous website visitors and anonymous desktop installs are
different IDs until sign-in or identity merging happens. Treat this funnel as
directionally useful, and treat `desktop_app_first_started` as the production
source of truth for successful installs/starts.

### Downloads By Platform, Last 30 Days

```sql
SELECT
  properties.platform AS platform,
  count() AS downloads,
  count(DISTINCT distinct_id) AS unique_downloaders
FROM events
WHERE event = 'website_download_clicked'
  AND timestamp >= now() - INTERVAL 30 DAY
GROUP BY platform
ORDER BY downloads DESC
```

### Landing Page To Download, Last 30 Days

```sql
SELECT
  pageviews,
  downloads,
  round(downloads * 100.0 / nullIf(pageviews, 0), 2) AS download_rate_percent
FROM
  (
    SELECT
      countIf(event = '$pageview') AS pageviews,
      countIf(event = 'website_download_clicked') AS downloads
    FROM events
    WHERE event IN ('$pageview', 'website_download_clicked')
      AND timestamp >= now() - INTERVAL 30 DAY
  )
```

### Desktop First Starts By Day

```sql
SELECT
  toStartOfDay(timestamp) AS day,
  count(DISTINCT distinct_id) AS first_starters
FROM events
WHERE event = 'desktop_app_first_started'
  AND timestamp >= now() - INTERVAL 30 DAY
GROUP BY day
ORDER BY day WITH FILL
  FROM toStartOfDay(now() - INTERVAL 30 DAY)
  TO toStartOfDay(now())
  STEP INTERVAL 1 DAY
```

## Dashboard 3: Dhee - Desktop Live Health

This dashboard tells us whether the desktop is being used right now and whether
the emitted session data is healthy.

### Recent Active Desktop Users

```sql
SELECT
  distinct_id,
  max(timestamp) AS last_seen_at,
  count() AS heartbeats
FROM events
WHERE event = 'desktop_heartbeat'
  AND timestamp >= now() - INTERVAL 30 MINUTE
GROUP BY distinct_id
ORDER BY last_seen_at DESC
LIMIT 100
```

### Recent Desktop Sessions

```sql
SELECT
  properties.$session_id AS session_id,
  any(distinct_id) AS distinct_id,
  min(timestamp) AS started_at,
  max(timestamp) AS last_seen_at,
  dateDiff('minute', min(timestamp), max(timestamp)) AS duration_minutes,
  count() AS events_seen
FROM events
WHERE timestamp >= now() - INTERVAL 24 HOUR
  AND event IN ('$screen', 'desktop_app_started', 'desktop_heartbeat', 'desktop_app_quit')
  AND properties.$session_id IS NOT NULL
GROUP BY session_id
ORDER BY last_seen_at DESC
LIMIT 100
```

### Desktop Session Events Missing Session ID

This should stay at zero after the current desktop analytics deployment.

```sql
SELECT
  event,
  count() AS events_missing_session_id
FROM events
WHERE timestamp >= now() - INTERVAL 24 HOUR
  AND event IN ('$screen', 'desktop_app_started', 'desktop_heartbeat', 'desktop_auth_started', 'desktop_app_quit')
  AND properties.$session_id IS NULL
GROUP BY event
ORDER BY events_missing_session_id DESC
```

### Core Sessions Without End Event, Last 24 Hours

```sql
SELECT count() AS sessions_without_end_event
FROM
  (
    SELECT
      properties.core_session_id AS core_session_id,
      countIf(event = 'core_session_started') AS starts,
      countIf(event = 'core_session_ended') AS ends
    FROM events
    WHERE event IN ('core_session_started', 'core_session_ended')
      AND timestamp >= now() - INTERVAL 24 HOUR
      AND properties.core_session_id IS NOT NULL
    GROUP BY core_session_id
    HAVING starts > ends
  )
```

## Dashboard 4: Dhee - Video Creation

This dashboard answers whether users are getting real value from the product.

### Videos Created By Day

```sql
SELECT
  toStartOfDay(timestamp) AS day,
  count() AS videos_created,
  count(DISTINCT distinct_id) AS creators
FROM events
WHERE event = 'final_video_created'
  AND timestamp >= now() - INTERVAL 30 DAY
GROUP BY day
ORDER BY day WITH FILL
  FROM toStartOfDay(now() - INTERVAL 30 DAY)
  TO toStartOfDay(now())
  STEP INTERVAL 1 DAY
```

### Video Duration Distribution

```sql
SELECT
  CASE
    WHEN toFloat(properties.duration_seconds) < 30 THEN '<30s'
    WHEN toFloat(properties.duration_seconds) < 60 THEN '30-60s'
    WHEN toFloat(properties.duration_seconds) < 180 THEN '1-3m'
    WHEN toFloat(properties.duration_seconds) < 300 THEN '3-5m'
    ELSE '5m+'
  END AS duration_bucket,
  count() AS videos
FROM events
WHERE event = 'final_video_created'
  AND timestamp >= now() - INTERVAL 30 DAY
  AND properties.duration_seconds IS NOT NULL
GROUP BY duration_bucket
ORDER BY videos DESC
```

### Task Success Rate, Last 7 Days

```sql
SELECT
  completed_tasks,
  failed_tasks,
  round(completed_tasks * 100.0 / nullIf(completed_tasks + failed_tasks, 0), 2) AS success_rate_percent
FROM
  (
    SELECT
      countIf(event = 'core_task_completed') AS completed_tasks,
      countIf(event = 'core_task_failed') AS failed_tasks
    FROM events
    WHERE event IN ('core_task_completed', 'core_task_failed')
      AND timestamp >= now() - INTERVAL 7 DAY
  )
```

### Top Failed Workflows, Last 7 Days

```sql
SELECT
  properties.workflow_name AS workflow_name,
  count() AS failures
FROM events
WHERE event = 'core_task_failed'
  AND timestamp >= now() - INTERVAL 7 DAY
GROUP BY workflow_name
ORDER BY failures DESC
LIMIT 20
```

### Tool Failures By Tool, Last 7 Days

```sql
SELECT
  properties.tool_name AS tool_name,
  count() AS failures
FROM events
WHERE event = 'core_tool_call_completed'
  AND timestamp >= now() - INTERVAL 7 DAY
  AND properties.is_error = true
GROUP BY tool_name
ORDER BY failures DESC
LIMIT 20
```

## Dashboard 5: Dhee - Desktop Projects & Location

This dashboard answers which desktop users are creating projects, what project
names they used, and where PostHog GeoIP places the usage. It intentionally
does not collect local filesystem paths or project descriptions.

### Projects Created, Last 30 Days

```sql
SELECT count() AS projects_created_30d
FROM events
WHERE event = 'project_created'
  AND timestamp >= now() - INTERVAL 30 DAY
```

### Unique Project Creators, Last 30 Days

```sql
SELECT count(DISTINCT distinct_id) AS unique_project_creators_30d
FROM events
WHERE event = 'project_created'
  AND timestamp >= now() - INTERVAL 30 DAY
```

### Projects Created By Day

```sql
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
```

### Recent Desktop Project Names

```sql
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
```

### Projects By Country, Region, And City

```sql
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
```

### Project Name Coverage QA

```sql
SELECT
  count() AS total_project_created_events,
  countIf(properties.project_name IS NOT NULL) AS with_project_name,
  round(with_project_name * 100.0 / nullIf(total_project_created_events, 0), 2) AS project_name_coverage_percent
FROM events
WHERE event = 'project_created'
  AND timestamp >= now() - INTERVAL 7 DAY
```

### Desktop Project GeoIP Coverage QA

```sql
SELECT
  count() AS total_project_created_events,
  countIf(properties.$geoip_country_name IS NOT NULL) AS with_geoip_country,
  countIf(properties.$geoip_subdivision_1_name IS NOT NULL) AS with_geoip_region,
  countIf(properties.$geoip_city_name IS NOT NULL) AS with_geoip_city,
  round(with_geoip_country * 100.0 / nullIf(total_project_created_events, 0), 2) AS geoip_country_coverage_percent
FROM events
WHERE event = 'project_created'
  AND timestamp >= now() - INTERVAL 7 DAY
```

## Dashboard 6: Dhee - Analytics QA

This dashboard catches tracking regressions.

### Event Freshness

```sql
SELECT
  event,
  max(timestamp) AS last_seen_at,
  count() AS events_24h
FROM events
WHERE timestamp >= now() - INTERVAL 24 HOUR
  AND event IN (
    '$pageview',
    '$screen',
    'website_download_clicked',
    'desktop_app_first_started',
    'desktop_app_started',
    'desktop_heartbeat',
    'project_created',
    'core_session_started',
    'core_session_ended',
    'core_task_started',
    'core_task_completed',
    'core_task_failed',
    'core_tool_call_started',
    'core_tool_call_completed',
    'final_video_created'
  )
GROUP BY event
ORDER BY last_seen_at DESC
```

### Legacy Events Still Emitting

This should be zero after the current analytics cleanup. Old event definitions
can remain visible in PostHog because PostHog keeps historical event metadata.

```sql
SELECT
  event,
  max(timestamp) AS last_seen_at,
  count() AS events_7d
FROM events
WHERE timestamp >= now() - INTERVAL 7 DAY
  AND event IN (
    'app_started',
    'session_started',
    'session_ended',
    'workflow_started',
    'workflow_completed',
    'workflow_failed',
    'tool_call_started',
    'tool_call_completed',
    'website_page_viewed'
  )
GROUP BY event
ORDER BY events_7d DESC
```

### New Session Events

```sql
SELECT
  event,
  count() AS count_24h,
  count(DISTINCT properties.$session_id) AS analytics_sessions
FROM events
WHERE timestamp >= now() - INTERVAL 24 HOUR
  AND event IN ('$pageview', '$screen', 'desktop_app_started', 'desktop_heartbeat')
GROUP BY event
ORDER BY count_24h DESC
```

### Core Session ID Coverage

```sql
SELECT
  event,
  total_events,
  with_core_session_id,
  round(with_core_session_id * 100.0 / nullIf(total_events, 0), 2) AS coverage_percent
FROM
  (
    SELECT
      event,
      count() AS total_events,
      countIf(properties.core_session_id IS NOT NULL) AS with_core_session_id
    FROM events
    WHERE timestamp >= now() - INTERVAL 24 HOUR
      AND event IN (
        'core_session_started',
        'core_session_ended',
        'core_task_started',
        'core_task_completed',
        'core_task_failed',
        'core_tool_call_started',
        'core_tool_call_completed',
        'final_video_created'
      )
    GROUP BY event
  )
ORDER BY coverage_percent ASC
```

## Sessions Page Notes

The PostHog Sessions UI will not backfill historical sessions from the old
custom `website_page_viewed` event. It needs fresh events with PostHog session
shape, especially `$pageview`, `$screen`, and `$session_id`.

After deploying the analytics changes:

1. Visit the website in a fresh browser session.
2. Start the desktop app.
3. Confirm fresh `$pageview`, `$screen`, `desktop_app_started`, and
   `desktop_heartbeat` events show `$session_id`.
4. Wait a few minutes for ingestion and then re-check the Sessions UI.

Session Replay is separate from server-side analytics events. The website can
have replay sessions if PostHog JS replay is configured and enabled. The
desktop's server-side events can still power session analytics through
`$session_id`, but they will not produce browser replay videos by themselves.

## Event Definition Hygiene

Recommended tags in PostHog Data Management:

- `website`: `$pageview`, `website_download_clicked`
- `desktop`: `$screen`, `desktop_app_first_started`, `desktop_app_started`, `desktop_heartbeat`, `desktop_app_quit`, `desktop_auth_started`, `project_created`
- `core`: `core_session_started`, `core_session_ended`, `core_task_started`, `core_task_completed`, `core_task_failed`, `core_tool_call_started`, `core_tool_call_completed`, `final_video_created`
- `legacy`: `app_started`, `session_started`, `session_ended`, `workflow_started`, `workflow_completed`, `workflow_failed`, `tool_call_started`, `tool_call_completed`, `website_page_viewed`

Do not delete old event definitions until any historical dashboards that depend
on them have been migrated or intentionally retired.

## Next Instrumentation To Add

These are not blockers for the dashboards above, but they are the next events
worth adding before production:

- `desktop_update_available`, `desktop_update_started`, `desktop_update_completed`, `desktop_update_failed`
- `desktop_app_crashed` with crash reason and version
- `auth_completed`, `auth_failed`, and `auth_signed_out`
- `project_opened` and `project_deleted`
- `template_selected` with template ID and category
- `video_generation_started`, `video_generation_failed`, and richer render timing properties
- `export_started`, `export_completed`, and `export_failed`
- `billing_plan_detected` or account tier properties once billing exists
