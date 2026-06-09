# Bundle Licensing

**Short version:** The `dhee-core` engine is AGPL-3.0-or-later. **Bundles are
not derivative works of the engine** — they are runtime data + runner manifests
loaded through the permissively-licensed `@dhee/runner-sdk` boundary. Bundle
authors choose their own license, including proprietary. The first-party
bundles shipped in this repo are **MIT**.

This document is the authoritative statement of that boundary. It exists so
that agencies, freelancers, and studios can publish commercial or proprietary
workflows without fear of AGPL contamination — which is what makes a bundle
marketplace possible.

---

## The boundary

```
dhee-core/                            AGPL-3.0-or-later
├── src/                                engine: walker, event log, registry,
│                                       LLM router, ComfyUI client, …
│                                       (the defensible core)
└── src/dag/bundles/*                   first-party bundles — MIT
                                        (data + manifests, NOT engine code)

packages/runner-sdk → @dhee/runner-sdk   Apache-2.0   ← THE FIREWALL
├── DagBundle / NodeDef / Runner / RunnerContext / RunnerManifest … (types)
└── defineRunner(), transientRetry, endpointResolver, inputsHash (helpers)

community bundles / runners              any license the author chooses
├── bundle.json (+ prompts, schemas, workflows)
├── custom runners  → import ONLY from @dhee/runner-sdk
└── never import from dhee-core/src internals
```

The Apache-2.0 `@dhee/runner-sdk` is the firewall. Bundle and runner authors
depend **only** on the SDK; they never import the AGPL engine. The engine
depends on the SDK and provides the runtime implementations behind the SDK's
interfaces (the same dependency-injection pattern `ctx.log` / `ctx.llm`
already use). Anything an author writes against the SDK inherits the Apache
boundary, not the engine's AGPL.

## Why this is legally clean

Bundles are loaded dynamically as data + manifests; they do not statically
link against engine code. This matches boundaries already accepted across OSS:

- **ComfyUI (GPL-3)** + community nodes (MIT/Apache) — nodes load dynamically.
- **Blender (GPL)** + add-ons (any license, including proprietary) — the
  Blender team has explicitly affirmed this.
- **VS Code / Cursor** + extensions (any license) — fully independent.

The two tests both pass:

1. **Can the artifact stand alone?** Yes — a `bundle.json` DAG (with its
   prompts/schemas/workflows) has meaning independent of the engine; it
   describes a pipeline, it is not engine code.
2. **Does it statically link engine internals?** No — it reaches the engine
   only through the `@dhee/runner-sdk` interface. Engine internals are not a
   public import surface.

The trap to avoid is the **WordPress** pattern (plugins declared derivative by
fiat). We do the opposite: the boundary is declared here, in writing, and
enforced mechanically by the SDK split (a runner that needs anything from
`dhee-core/src` fails to compile against the SDK alone).

## Declaring a bundle's license

Every bundle declares its license via the `license` field in `bundle.json`
(an SPDX identifier), and SHOULD include a matching `LICENSE` file in the
bundle directory so the license travels with the artifact when it is copied,
packaged, or published to npm.

```jsonc
{
  "id": "my_bundle",
  "version": "0.1.0",
  "license": "MIT",          // SPDX id; "Apache-2.0", "CC-BY-4.0",
  ...                         // or "LicenseRef-Proprietary" for closed bundles
}
```

- **First-party bundles** in this repo (`src/dag/bundles/*`) are **MIT** — they
  double as copy-paste templates, so the most permissive practical license is
  the right default.
- **Community bundles**: any OSI-approved license, or "all rights reserved"
  proprietary. The marketplace requires a declared license on submission;
  undeclared bundles are rejected. Default suggestion for community
  contributions is **MIT**.
- **Premium / first-party closed bundles** may be proprietary
  (`LicenseRef-Proprietary`) — the boundary supports this exactly so the
  premium tier can ship closed alongside open community bundles.

## Edge cases (pre-decided)

- **Media assets in bundles** (reference images, audio, fonts): each asset
  carries its own license; the aggregate bundle license is declared separately.
  Don't assume the bundle's code license covers bundled media.
- **AI model weights / LoRAs referenced by a bundle** (FLUX, LTX, Qwen, …):
  model licenses pass through unchanged. The bundle author is responsible for
  declaring an aggregate license that respects every referenced model's terms.
- **Bundle composition** (a bundle depending on other bundles): the author
  declares the aggregate license; transitive licenses must be compatible. The
  marketplace can flag conflicts at install time.
- **Custom runners** (not just bundles): clean **only** if they extend the
  engine through the `@dhee/runner-sdk` interface. A runner that reaches into
  `dhee-core/src` internals is contaminated — the SDK interface is the
  enforcement boundary, and engine internals must never become a public import.

## What this is NOT

This does not relicense the engine. `dhee-core/src` (the walker, event log,
registry, LLM router, ComfyUI client, ffmpeg/watermark, and all first-party
runners that import them) stays AGPL-3.0-or-later. The AGPL defense against
closed-cloud absorption is intact; the bundle boundary simply keeps that
defense from leaking onto independently-authored bundles and runners.

See also: [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the contributor
agreement (CLA) and [`LICENSE`](./LICENSE) for the engine license.
