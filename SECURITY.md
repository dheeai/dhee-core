# Security Policy

`dhee-core` is a local-first AI video generation engine. It can run an HTTP/WebSocket server, read and write project files, call LLM/VLM providers, call ComfyUI or Comfy Cloud, and invoke media tooling such as ffmpeg. Treat it as software with access to your local projects, generated media, and configured provider credentials.

## Reporting a Vulnerability

Report vulnerabilities privately through GitHub's private vulnerability reporting for this repository. If private reporting is unavailable, contact a maintainer privately before publishing details.

Do not open public issues for exploitable security bugs. A useful report includes:

- A concise description and severity assessment.
- The affected component or file path.
- Reproduction steps against `master` or the latest release.
- OS, Node.js version, `pnpm` version, and `dhee-core` commit SHA.
- Relevant logs with secrets, project content, and provider keys removed.

This project does not currently operate a bug bounty program.

## Supported Versions

Security fixes target `master` and the latest published release. Older local builds should be upgraded before reporting unless the issue still reproduces on current code.

## Trust Model

### Local Mode

Local use is intended for a single trusted user on one machine. The server binds to `127.0.0.1` by default, and discovery data is written to `~/.dhee/server.json` with best-effort `0600` permissions.

Keep the server bound to loopback. On a shared machine, access to the same user account is effectively access to the local Dhee session.

### Isolation Boundary

The only strong isolation boundary is the operating system or container boundary you run `dhee-core` inside. Prompt rules, schema validation, provider routing, and UI checks are guardrails, not containment.

For untrusted workflows or shared machines, run `dhee-core` as a non-root user inside a container or VM with explicit filesystem and network limits.

## In Scope

Security reports are in scope when they demonstrate one of these outcomes:

- Path traversal or arbitrary file read/write outside intended project, upload, workflow, or output directories.
- Credential leakage through logs, telemetry, API responses, WebSocket messages, generated files, or provider requests.
- Command injection through ffmpeg, workflow handling, provider configuration, project names, asset paths, or uploaded metadata.
- Cross-project data exposure between sessions or clients.
- Supply-chain or dependency behavior that can execute attacker-controlled code during install, build, or runtime.

## Out of Scope

These are not treated as security vulnerabilities unless chained to an in-scope outcome:

- Prompt injection by itself.
- Low-quality, unexpected, or unsafe model output with no access-control or data-leak impact.
- A local user reading or modifying files already accessible to their OS account.
- Malicious third-party ComfyUI workflows, custom nodes, scripts, or models that an operator chose to install without review.
- Provider-side issues in OpenAI, OpenRouter, Gemini, xAI, Comfy Cloud, LM Studio, or local ComfyUI.
- API cost, quota, or billing impact caused by an authorized user action.

## Deployment Hardening

- Keep the default loopback binding for local use.
- Run as a non-root user.
- Prefer a container or VM for shared or untrusted deployments.
- Keep `.env`, `.llm-routing.json`, generated projects, uploads, logs, and provider credentials out of git.
- Review third-party workflows, ComfyUI custom nodes, and model files before use.
- Rotate provider keys if logs, generated projects, or support bundles may have exposed secrets.
- Avoid storing private user media in shared project directories.

## Disclosure

We aim to acknowledge private reports promptly and coordinate disclosure after a fix is available. Public disclosure before maintainers have had time to triage and patch may put users at risk.
