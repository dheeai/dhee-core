# dhee Cloud Architecture: Proxy-Based Metering

**Status:** Proposal
**Author:** Ganaraj
**Date:** 2026-04-30

---

## TL;DR

Today, "cloud mode" runs the entire dhee core on our servers. The only real reason for that is so we can track usage of paid upstream APIs (ComfyUI Cloud, OpenRouter) and bill users for credits.

This proposal: **stop running the core in the cloud.** Always run the core on the user's desktop. Put a thin **authenticated proxy** in front of the two paid upstream services. Meter and bill at the proxy. The desktop app authenticates with a per-user JWT/API key, and every paid call routes through the proxy where we deduct credits.

The proxy is the only piece of cloud infrastructure we need to operate. The core stays a single codebase that runs identically everywhere.

---

## Current Architecture

```
   ┌─────────────────────┐                                ┌──────────────────────────┐
   │    Local Mode       │                                │      Cloud Mode          │
   │                     │                                │                          │
   │  ┌──────────────┐   │                                │   ┌──────────────────┐   │
   │  │ dhee       │   │                                │   │ dhee Desktop   │   │
   │  │ Desktop      │   │                                │   │  (thin client)   │   │
   │  └──────┬───────┘   │                                │   └────────┬─────────┘   │
   │         │           │                                │            │             │
   │         │ runs      │                                │            │ remote      │
   │         ▼           │                                │            ▼             │
   │  ┌──────────────┐   │                                │   ┌──────────────────┐   │
   │  │ dhee Core  │   │                                │   │  dhee Core     │   │
   │  │ (local)      │   │                                │   │  (our servers)   │   │
   │  └──────┬───────┘   │                                │   └────────┬─────────┘   │
   │         │           │                                │            │             │
   └─────────┼───────────┘                                └────────────┼─────────────┘
             │                                                         │
             ▼                                                         ▼
   ┌─────────────────────┐                                ┌──────────────────────────┐
   │  ComfyUI Cloud      │                                │  ComfyUI Cloud           │
   │  OpenRouter         │                                │  OpenRouter              │
   │  (user pays direct) │                                │  (we pay, bill user)     │
   └─────────────────────┘                                └──────────────────────────┘
```

### Problems with running the core in the cloud

1. **Heavy infrastructure.** The core orchestrates long-running pipelines, runs FFmpeg, manages large media files, and writes per-project state to disk. Hosting it means we run real compute, real storage, and real lifecycle (queues, workers, retries) on our side — for every active user.
2. **Project data leaves the user's machine.** Stories, characters, generated frames, and final videos all live on our servers in cloud mode. That's a privacy and trust burden we don't need.
3. **Two code paths to maintain.** "Local mode" and "cloud mode" are subtly different deployments of the same core, with different file system assumptions, different auth surfaces, and different failure modes. Bugs in one don't reproduce in the other.
4. **The reason we're doing this is small.** The actual goal is **metering and billing for paid API calls.** Hosting the entire orchestration engine just to observe two outbound HTTP destinations is overkill.

---

## Proposed Architecture: Authenticated Proxy

```
                      ┌────────────────────────────────────────────┐
                      │           User's Desktop (always)          │
                      │                                            │
                      │   ┌──────────────────────────────────────┐ │
                      │   │       dhee Desktop + Core         │ │
                      │   │   (single codebase, local files)    │ │
                      │   └────────────────┬─────────────────────┘ │
                      └────────────────────┼───────────────────────┘
                                           │
                                           │  Authenticated:
                                           │  Authorization: Bearer <user-JWT>
                                           ▼
                      ┌────────────────────────────────────────────┐
                      │      dhee Cloud Proxy (our infra)        │
                      │                                            │
                      │   • Verifies JWT / API key                 │
                      │   • Looks up user's credit balance         │
                      │   • Forwards request to upstream           │
                      │   • Records usage on response              │
                      │   • Deducts credits                        │
                      │   • Rate limits + abuse controls           │
                      └──────────────┬───────────────┬─────────────┘
                                     │               │
                                     ▼               ▼
                            ┌─────────────────┐  ┌──────────────────┐
                            │  ComfyUI Cloud  │  │   OpenRouter     │
                            └─────────────────┘  └──────────────────┘
```

### How it works

1. **User signs in** to the desktop app. The app receives a JWT (short-lived) or a long-lived API key — either is fine; JWT with refresh is cleaner.
2. **The desktop app runs the core locally**, exactly like it does in local mode today. No special "cloud mode" code path.
3. **The core's outbound HTTP destinations are configurable.** When the user is signed in to dhee Cloud, we point the two upstream base URLs at our proxy:
   - `COMFYUI_BASE_URL` → `https://proxy.dhee.cloud/comfy`
   - `OPENROUTER_BASE_URL` → `https://proxy.dhee.cloud/openrouter`
4. **Every request includes the user's bearer token.** The proxy authenticates and authorizes before forwarding.
5. **The proxy meters usage and deducts credits.** For LLM calls it reads token counts from the response. For ComfyUI calls it records job duration / GPU minutes / a fixed cost per workflow type.
6. **If credits are exhausted**, the proxy returns 402 Payment Required and the desktop app surfaces the upgrade flow.

### What the proxy is — and is not

The proxy is **a thin authenticated reverse proxy with a usage ledger.** That's it.

It is **not**:
- a queue
- an orchestration engine
- a file store
- a cache for user project data
- a wrapper that understands dhee-specific concepts like "scenes" or "shots"

The proxy speaks ComfyUI's protocol and OpenRouter's protocol, byte-for-byte, with two additions: an auth header it consumes and a usage row it writes per request.

---

## Why this is better

| Concern | Cloud-Core (today) | Proxy (proposed) |
|---|---|---|
| **Where compute runs** | Our servers | User's machine (free to us) |
| **Where storage lives** | Our servers (large) | User's machine |
| **Code paths** | Two (local + cloud) | One |
| **Privacy** | User content on our servers | User content stays local |
| **Scaling** | Per-user worker / container | Stateless proxy, trivial to scale |
| **Operational surface** | Full orchestration stack | Reverse proxy + ledger DB |
| **Cost to us** | Compute + storage + bandwidth | Just bandwidth + tiny DB |
| **Time-to-build** | Significant | Small |

The metering goal is fully preserved — we still see every billable call, because the only path to ComfyUI Cloud or OpenRouter goes through us.

---

## Implementation Notes

### Authentication

- JWT issued by our auth service on login, ~1h TTL, refresh token for renewal.
- Desktop app stores tokens in OS keychain (Keychain on macOS, Credential Manager on Windows).
- Proxy validates the JWT signature and a small set of claims (`sub`, `exp`, `plan`).

### Credit accounting

- **OpenRouter / LLM calls:** OpenRouter responses include token counts per call. Proxy reads `usage.prompt_tokens` and `usage.completion_tokens` from the response body and applies a per-model rate. For streaming, accumulate from the final `usage` chunk.
- **ComfyUI Cloud:** charge per workflow run, by job duration or by a per-node table. The proxy already sees the workflow JSON on submit and the completion event on the websocket — both sufficient to bill.
- Write one row to a `usage_events` table per call. Credit balance is `total_purchased - sum(usage_events)`. Cache the balance with short TTL for fast pre-check.

### Streaming

- LLM responses are often SSE/streamed. The proxy must stream-pass-through, not buffer. Read the final usage event from the stream tail to record consumption.
- ComfyUI uses websockets for progress and final outputs. The proxy needs to terminate one WS from the client and open another to ComfyUI, relaying frames in both directions. Standard reverse-proxy WS handling.

### Pre-flight credit check

Before forwarding, the proxy checks the user has *some* credit headroom (don't need to know exact cost yet). This stops obviously-broke users at the door without doing the upstream call. Final exact deduction happens on the response.

### Error handling

- Proxy down → desktop app surfaces "dhee Cloud is unavailable, retry or switch to BYO-keys mode." Optionally, allow the user to fall back to direct calls with their own ComfyUI/OpenRouter keys if they have them.
- Upstream down → proxy returns the upstream error verbatim. Don't charge for failed calls.
- Partial failures (call succeeded upstream, ledger write failed) → write to a durable retry queue; never double-charge, never under-charge silently.

### Abuse and rate limiting

- Per-user request rate limit at the proxy.
- Per-user concurrent ComfyUI job cap.
- Per-IP soft limit to slow brute-force token guessing.
- Anomaly detection on credit burn rate (alert if user burns 10x their normal in 10 minutes).

### Caching

The proxy is **not** a cache for user content. Any caching is incidental (e.g., a CDN in front of static upstream errors). The core already handles its own caching of generated assets locally.

### Per-environment config in the core

In `dhee-core`, the upstream URLs are already configurable (see `COMFY_MODE` / `COMFYUI_BASE_URL` precedence in memory). We need:
- A `dhee_CLOUD=true` mode that sets both base URLs to the proxy and injects the bearer token on every request.
- An auth client in the desktop app that handles login, token refresh, and surfaces 402 / 401 from the proxy as user-facing flows.

---

## Migration

1. **Phase 1 — Build proxy.** Stand up `proxy.dhee.cloud` with auth, ledger, and pass-through for both upstreams. Test against a single dev account.
2. **Phase 2 — Desktop integration.** Add login flow, token storage, and `dhee_CLOUD` mode to the desktop app. Internal dogfooding.
3. **Phase 3 — Sunset cloud-core.** Once the proxy path is healthy, deprecate the hosted core. Existing cloud-mode users get migrated to "logged-in desktop" mode.
4. **Phase 4 — Plans and billing UI.** Subscription tiers, top-ups, usage dashboard. None of this needs the hosted core; it's all proxy-side.

---

## Open Questions

- **BYO-keys mode** — do we let advanced users plug in their own ComfyUI / OpenRouter keys and skip our proxy entirely? Probably yes, as a power-user escape hatch. It keeps us honest on pricing.
- **Multi-region proxy** — latency to OpenRouter and ComfyUI Cloud may vary. Likely a v2 problem; start with one region.
- **Per-call price calibration** — we need a pricing table that converts upstream costs (which we know exactly) into user-facing credits (which include our margin). This belongs in proxy config, not in the core.
- **Audit / receipts** — should users see a per-call breakdown? Useful for trust; cheap to expose since we already have the ledger.

---

## Summary

Run the core where it belongs — on the user's machine. Put a small authenticated proxy in front of the two paid upstreams to handle metering. That single change collapses two deployment modes into one, removes a large operational burden, and still gives us perfect visibility into billable usage.
