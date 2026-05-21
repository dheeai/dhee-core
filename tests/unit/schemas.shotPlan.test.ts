import { describe, it, expect } from "vitest";
import {
  shotPlanSchema,
  shotPlanEntrySchema,
  singleShotSchema,
  JSON_SCHEMAS,
  getPromptSchema,
  maxTokensForJsonNode,
  validateWithSchema,
} from "../../src/core/planner/schemas.js";

const validPlanEntry = {
  shotNumber: 1,
  purpose: "meet_character" as const,
  duration: 4,
  oneLineSummary: "Parvati walks the last stretch of road to the Singh bungalow.",
};

const validPlan = {
  sceneNumber: 2,
  sceneTitle: "Arrival at the Singh House",
  totalDuration: 79,
  mainSubject: "parvati",
  secondarySubject: "mrs._singh",
  entry: "Parvati steps off the bus, dust settling.",
  exit: "Parvati closes the bungalow gate behind her.",
  shotPlan: [
    validPlanEntry,
    {
      shotNumber: 2,
      purpose: "show_action" as const,
      duration: 3,
      oneLineSummary: "She pushes open the servant's door, kitchen smells hit.",
      perspective: "main_subject" as const,
      continuityRole: "entry" as const,
    },
  ],
};

describe("shotPlanEntrySchema", () => {
  it("accepts a minimal valid entry", () => {
    expect(shotPlanEntrySchema.safeParse(validPlanEntry).success).toBe(true);
  });

  it("rejects when shotNumber is missing", () => {
    const { shotNumber: _drop, ...bad } = validPlanEntry;
    expect(shotPlanEntrySchema.safeParse(bad).success).toBe(false);
  });

  it("rejects when oneLineSummary is empty", () => {
    expect(shotPlanEntrySchema.safeParse({ ...validPlanEntry, oneLineSummary: "" }).success).toBe(false);
  });

  it("rejects unknown purpose values", () => {
    expect(
      shotPlanEntrySchema.safeParse({ ...validPlanEntry, purpose: "made_up_purpose" }).success,
    ).toBe(false);
  });

  it("accepts optional perspective and continuityRole", () => {
    const r = shotPlanEntrySchema.safeParse({
      ...validPlanEntry,
      perspective: "observer",
      continuityRole: "bridge",
    });
    expect(r.success).toBe(true);
  });
});

describe("shotPlanSchema", () => {
  it("accepts a fully populated plan", () => {
    const r = shotPlanSchema.safeParse(validPlan);
    expect(r.success).toBe(true);
  });

  it("accepts a plan with no secondarySubject", () => {
    const { secondarySubject: _drop, ...plan } = validPlan;
    expect(shotPlanSchema.safeParse(plan).success).toBe(true);
  });

  it("accepts secondarySubject set to null", () => {
    expect(shotPlanSchema.safeParse({ ...validPlan, secondarySubject: null }).success).toBe(true);
  });

  it("rejects when shotPlan is empty", () => {
    expect(shotPlanSchema.safeParse({ ...validPlan, shotPlan: [] }).success).toBe(false);
  });

  it("rejects when mainSubject is missing", () => {
    const { mainSubject: _drop, ...bad } = validPlan;
    expect(shotPlanSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects when sceneNumber is the wrong type", () => {
    expect(shotPlanSchema.safeParse({ ...validPlan, sceneNumber: "two" }).success).toBe(false);
  });
});

describe("singleShotSchema", () => {
  it("accepts a minimal valid shot (description-only)", () => {
    const r = singleShotSchema.safeParse({
      shotNumber: 1,
      purpose: "show_action",
      duration: 4,
      description: "Parvati steps inside.",
      cameraWork: "medium, static",
      audio: "footsteps on tile",
      transition: "cut",
      perspective: "main_subject",
    });
    expect(r.success).toBe(true);
  });

  it("rejects a shot with neither description nor firstFrame.description", () => {
    const r = singleShotSchema.safeParse({
      shotNumber: 1,
      purpose: "show_action",
      duration: 4,
      cameraWork: "medium",
      audio: "ambient",
      transition: "cut",
      perspective: "main_subject",
    });
    expect(r.success).toBe(false);
  });

  it("requires perspective for show_action shots", () => {
    const r = singleShotSchema.safeParse({
      shotNumber: 1,
      purpose: "show_action",
      duration: 4,
      description: "Parvati steps inside.",
      cameraWork: "medium",
      audio: "footsteps",
      transition: "cut",
    });
    expect(r.success).toBe(false);
  });

  it("requires perspective for meet_character shots", () => {
    const r = singleShotSchema.safeParse({
      shotNumber: 1,
      purpose: "meet_character",
      duration: 4,
      description: "Mrs. Singh sits at the table.",
      cameraWork: "medium",
      audio: "newspaper rustle",
      transition: "cut",
    });
    expect(r.success).toBe(false);
  });
});

describe("registry hookup", () => {
  it("registers scene_shot_plan in JSON_SCHEMAS", () => {
    expect(JSON_SCHEMAS.scene_shot_plan).toBeDefined();
    expect(JSON_SCHEMAS.scene_shot_plan).toBe(shotPlanSchema);
  });

  it("registers shot_breakdown in JSON_SCHEMAS", () => {
    expect(JSON_SCHEMAS.shot_breakdown).toBeDefined();
    expect(JSON_SCHEMAS.shot_breakdown).toBe(singleShotSchema);
  });

  it("validateWithSchema works for scene_shot_plan", () => {
    const r = validateWithSchema("scene_shot_plan", validPlan);
    expect(r.valid).toBe(true);
  });

  it("validateWithSchema rejects an empty plan", () => {
    const r = validateWithSchema("scene_shot_plan", { ...validPlan, shotPlan: [] });
    expect(r.valid).toBe(false);
  });

  it("getPromptSchema returns a schema block for scene_shot_plan", () => {
    const block = getPromptSchema("scene_shot_plan");
    expect(block).toContain("<json_schema>");
    expect(block).toContain("shotPlan");
    expect(block).toContain("oneLineSummary");
  });

  it("getPromptSchema returns a schema block for shot_breakdown", () => {
    const block = getPromptSchema("shot_breakdown");
    expect(block).toContain("<json_schema>");
    expect(block).toContain("cameraWork");
    expect(block).toContain("transition");
  });

  it("maxTokensForJsonNode budgets the new node types with enough headroom for reasoning-model chains-of-thought", () => {
    // Reasoning models (DeepSeek-R, o-series, Gemini-thinking, Claude
    // w/ extended thinking) emit chain-of-thought tokens INTO
    // max_tokens before the JSON. The original 3000 cap was eaten by
    // reasoning, output truncated mid-stream, and json_repair turned
    // the partial bytes into a "Default scene / Default shot." stub.
    // The bumped cap is effectively no-cap — providers don't charge
    // for unused headroom; the LLM stops when it's done emitting.
    expect(maxTokensForJsonNode("scene_shot_plan")).toBeGreaterThanOrEqual(20000);
    expect(maxTokensForJsonNode("shot_breakdown")).toBeGreaterThanOrEqual(20000);
  });
});
