#!/usr/bin/env node
/**
 * dhee-core CLI entry point — boots pi's interactive TUI with the
 * dhee tool surface registered as an extension. Replaces the legacy
 * React Ink TUI.
 */
import "dotenv/config";
import { bootdheeTUI } from "./agent/pi/index.js";

bootdheeTUI(process.argv.slice(2)).catch((err) => {
  console.error("dhee-core failed to start:", err);
  process.exit(1);
});
