/**
 * `dhee_describe_image` — pi-agent's on-demand vision tool.
 *
 * The auto-described asset events (the `[SYSTEM EVENT]` messages with
 * a `vlm_description`) cover assets *as they're generated*. This tool
 * lets the agent ask the VLM about ANY image on disk, on demand —
 * useful when:
 *   - The user asks "is shot 1 actually showing the diner exterior?"
 *     and the agent needs to look at an existing image.
 *   - The agent has just edited a prompt and wants to validate the
 *     fresh regen against its intent before claiming success.
 *   - Cross-checking continuity between two frames (call twice with
 *     a context-prompt that asks about the same character).
 *
 * The optional `expectedPrompt` is fed to the VLM as the prompt the
 * image was supposed to render — same plumbing as the supervisor
 * loop's `describeImageWithVLM` so the description includes a
 * targeted match-or-miss assessment, not just generic captioning.
 *
 * Returns the VLM's plain-text description. When VLM_* is unconfigured
 * (or the call fails), the helper returns null; the tool surfaces that
 * as a clear "VLM not configured" text result so the agent doesn't
 * silently lose information.
 */
import { resolve, relative, sep, isAbsolute } from "node:path";
import { existsSync } from "node:fs";
import { Type, type Static } from "typebox";
import { defineTool } from "@mariozechner/pi-coding-agent";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { describeImageWithVLM } from "../../../core/llm/describeImageWithVLM.js";
import { resolveProjectDir } from "./resolveProjectDir.js";
import { getProjectsDir } from "../paths.js";

const Params = Type.Object({
  project: Type.String({
    description:
      "Project name as it appears in the projects folder (no .dhee suffix needed).",
  }),
  path: Type.String({
    description:
      "Path to the image. Relative paths resolve against the project folder (e.g. 'assets/scene_1/shot_1/first_frame.png'). Absolute paths must point inside the project folder.",
  }),
  expectedPrompt: Type.Optional(
    Type.String({
      description:
        "Optional: the prompt the image was supposed to render. The VLM uses this to flag mismatches and identity drift, not just generic captioning. When omitted, the VLM produces a plain description.",
    }),
  ),
  projectDir: Type.Optional(
    Type.String({
      description:
        "Optional absolute path to the project folder. Use when the project lives outside the default projects directory (desktop workspace folder).",
    }),
  ),
});

export interface DescribeImageDetails {
  resolvedPath: string;
  vlmConfigured: boolean;
}

export const dheeDescribeImage = defineTool({
  name: "dhee_describe_image",
  label: "dhee describe-image",
  description:
    "Ask the VLM to describe an image inside a dhee project. Returns plain-text description plus an artifact assessment. Use to validate generated frames against intent, cross-check continuity, or answer 'what's actually in this image?' questions. Optional expectedPrompt anchors the VLM to do a match-or-miss assessment instead of generic captioning.",
  parameters: Params,
  async execute(
    _id,
    params: Static<typeof Params>,
  ): Promise<AgentToolResult<DescribeImageDetails>> {
    const projectDir = resolveProjectDir({
      name: params.project,
      basePath: getProjectsDir(),
      ...(params.projectDir ? { projectDir: params.projectDir } : {}),
    });

    const target = isAbsolute(params.path)
      ? resolve(params.path)
      : resolve(projectDir, params.path);

    // Path-traversal guard — same shape as dhee_read_artifact. We
    // don't want pi-agent to point the VLM at arbitrary host files.
    const rel = relative(projectDir, target);
    if (rel.startsWith("..") || rel.startsWith(`..${sep}`)) {
      throw new Error(
        `Path '${params.path}' resolves outside project '${params.project}'`,
      );
    }
    if (!existsSync(target)) {
      throw new Error(`Image not found at ${target}`);
    }

    const description = await describeImageWithVLM(
      target,
      params.expectedPrompt ?? "(no expected prompt provided)",
    );

    if (description === null) {
      const text =
        "VLM not configured or call failed. Set VLM_PROVIDER / VLM_API_KEY / " +
        "VLM_MODEL in Settings → Connection → VLM (or in dhee-core/.env for " +
        "dev mode), then retry. The vlmJudge toggle in Settings → Appearance " +
        "must also be on.";
      return {
        content: [{ type: "text", text }],
        details: { resolvedPath: target, vlmConfigured: false },
      };
    }

    return {
      content: [{ type: "text", text: description }],
      details: { resolvedPath: target, vlmConfigured: true },
    };
  },
});
