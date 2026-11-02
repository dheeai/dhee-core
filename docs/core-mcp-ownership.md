# Core-owned production MCP

User-approved correction, 2 November 2026: Core owns the MCP protocol server and shared production controller. Codex calls Core MCP; Desktop uses the same Core controller. Desktop retains UI and independent media runners. No second executor.

Implementation: move protocol and bounded stdio lifecycle into Core; export `dhee-core/mcp` and `dhee-core/mcp/stdio`; ship `dhee-core-mcp`. Keep Desktop's old launcher as a thin compatibility shim that configures its runner extension then starts Core's server. No protocol implementation remains in Desktop. Core never imports Desktop. Hosts expose optional installed runners with `DHEE_NODE_MODULES_DIRS`.

Acceptance: migrated nine protocol tests (including active output-disconnect cleanup), direct Core handshake and public export/bin checks, real Brilliant Care media chain through Core MCP with explicit Desktop runner discovery. Preserve review gates, source hashes, exact execution and approved media. Update Codex registration to the Core command after local verification. No new generation, no approval fabrication. Local correction first; no additional push without user instruction.
