# Compute Engine deployment assets

This folder contains VM-side assets used by the GitHub Actions deploy workflow.

Runtime app configuration (`LLM_*`, `OPENAI_*`, `COMFYUI_*`, `POSTHOG_*`, `ANALYTICS_SALT`) is loaded in CI from **Google Secret Manager** in `GCP_PROJECT_ID` (same names as the secrets). Optional `DEV_*` secrets in GCP override staging `.env.dev` when present.

## Files

- `docker-compose.yml`: runs `dhee-core-prod`, `dhee-core-dev`, and `nginx`
- `nginx.conf`: routes `/` to prod and `/dev/` to dev
- `deploy.sh`: updates only one branch service at a time
- `.env.example`: required runtime environment keys
- `bootstrap-vm.sh`: one-time bootstrap helper for a fresh VM

## Required VM runtime files

Create these files in the same directory on the VM:

- `.env.prod`
- `.env.dev`

They follow the schema in `.env.example`.
