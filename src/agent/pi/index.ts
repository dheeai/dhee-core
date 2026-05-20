import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { dheeTools } from "./tools/index.js";
import { loadOrchestratorPrompt } from "./prompt.js";
import { ensureDir, getdheeConfigDir, getProjectsDir } from "./paths.js";
import { ensureOpenRouterApiKeyFromEnv } from "./ensureOpenRouterKey.js";

export const dheeExtension: ExtensionFactory = (pi) => {
  for (const tool of dheeTools) {
    pi.registerTool(tool);
  }
};

function applyHeavyTierDefaults(argv: string[]): string[] {
  const tierProvider = process.env["LLM_TIER_HEAVY_PROVIDER"];
  const tierModel = process.env["LLM_TIER_HEAVY_MODEL"];
  ensureOpenRouterApiKeyFromEnv();

  const userPickedProvider = argv.some((a) => a === "--provider");
  const userPickedModel = argv.some((a) => a === "--model" || a.startsWith("--model="));

  const defaults: string[] = [];
  if (!userPickedProvider && tierProvider) {
    defaults.push("--provider", tierProvider);
  }
  if (!userPickedModel && tierModel) {
    defaults.push("--model", tierModel);
  }
  return defaults;
}

function ensuredheeAgentDir(): string {
  const agentDir = ensureDir(join(getdheeConfigDir(), "pi-agent"));
  const settingsPath = join(agentDir, "settings.json");
  if (!existsSync(settingsPath)) {
    writeFileSync(
      settingsPath,
      JSON.stringify({ quietStartup: true }, null, 2) + "\n",
      "utf8",
    );
  } else {
    try {
      const current = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
      if (current["quietStartup"] === undefined) {
        current["quietStartup"] = true;
        writeFileSync(settingsPath, JSON.stringify(current, null, 2) + "\n", "utf8");
      }
    } catch {
      // Malformed settings — leave alone so the user can fix.
    }
  }
  return agentDir;
}

export async function bootdheeTUI(argv: string[] = []): Promise<void> {
  const { main } = await import("@mariozechner/pi-coding-agent");
  const agentDir = ensuredheeAgentDir();
  if (!process.env["PI_CODING_AGENT_DIR"]) {
    process.env["PI_CODING_AGENT_DIR"] = agentDir;
  }
  const projectsDir = ensureDir(getProjectsDir());
  process.chdir(projectsDir);
  const tierDefaults = applyHeavyTierDefaults(argv);
  const baseArgs = [
    "--system-prompt",
    loadOrchestratorPrompt(),
    ...tierDefaults,
    ...argv,
  ];
  await main(baseArgs, { extensionFactories: [dheeExtension] });
}

export { dheeTools };

// Embed surface — hosts that want to drive a PiSessionAgent in-process
// (e.g. the Electron desktop app) import these directly. Keep this
// barrel in sync with the package.json `./agent/pi` export.
export { PiSessionAgent } from "./PiSessionAgent.js";
export type { MediaCallback, MediaEvent } from "./tools/runTo.js";
