import { describe, it, expect } from "vitest";
import { assembleSceneVideoPrompt } from "../../src/core/planner/sceneVideoPromptAssembler.js";
import { sceneVideoPromptSchema } from "../../src/core/planner/schemas.js";

const planBase = {
  sceneNumber: 2,
  sceneTitle: "Arrival at the Singh House",
  totalDuration: 13,
  mainSubject: "parvati",
  secondarySubject: "mrs._singh",
  entry: "Parvati steps off the bus, dust settling.",
  exit: "Parvati closes the bungalow gate behind her.",
  shotPlan: [
    { shotNumber: 1, purpose: "meet_character" as const, duration: 4, oneLineSummary: "Parvati walks the last stretch of road." },
    { shotNumber: 2, purpose: "show_action" as const,    duration: 3, oneLineSummary: "She pushes open the servant's door." },
    { shotNumber: 3, purpose: "show_dialogue" as const,  duration: 6, oneLineSummary: "Mrs. Singh greets her without looking up." },
  ],
};

const shot1 = {
  shotNumber: 1,
  purpose: "meet_character" as const,
  duration: 4,
  description: "Parvati walks the last stretch of road to the Singh bungalow.",
  cameraWork: "medium, slight low angle, tracking left to right",
  perspective: "main_subject" as const,
  perspectiveOf: "parvati",
  focus: { primary: "parvati", background: ["singh_bungalow"], lurking: null },
  continuityRole: "entry" as const,
  audio: "footsteps on gravel, distant cicada hum",
  transition: "fade",
};

const shot2 = {
  shotNumber: 2,
  purpose: "show_action" as const,
  duration: 3,
  description: "Parvati pushes open the blue peeling servant's door.",
  cameraWork: "close-up on hand pushing door, shallow DOF",
  perspective: "main_subject" as const,
  focus: { primary: "parvati_face", background: ["kitchen_stove"] },
  continuityRole: "entry" as const,
  audio: "door creak, sizzle of frying",
  transition: "cut",
};

const shot3 = {
  shotNumber: 3,
  purpose: "show_dialogue" as const,
  duration: 6,
  description: "Mrs. Singh sits at the polished teak table, teacup in hand.",
  cameraWork: "medium shot from side, slightly high angle",
  perspective: "secondary_subject" as const,
  focus: { primary: "mrs._singh", background: ["teak_table"] },
  continuityRole: "none" as const,
  audio: "MRS. SINGH: You're late, Parvati. Newspaper rustle.",
  transition: "cut",
};

describe("assembleSceneVideoPrompt", () => {
  it("assembles plan + shots into a valid sceneVideoPromptSchema-shaped object", () => {
    const out = assembleSceneVideoPrompt(planBase, [shot1, shot2, shot3]);
    expect(sceneVideoPromptSchema.safeParse(out).success).toBe(true);
    expect(out.sceneNumber).toBe(2);
    expect(out.sceneTitle).toBe("Arrival at the Singh House");
    expect(out.totalDuration).toBe(13);
    expect(out.mainSubject).toBe("parvati");
    expect(out.secondarySubject).toBe("mrs._singh");
    expect(out.entry).toBe(planBase.entry);
    expect(out.exit).toBe(planBase.exit);
    expect(out.shots).toHaveLength(3);
  });

  it("sorts shots by shotNumber regardless of input order", () => {
    const out = assembleSceneVideoPrompt(planBase, [shot3, shot1, shot2]);
    expect(out.shots.map(s => s.shotNumber)).toEqual([1, 2, 3]);
  });

  it("omits secondarySubject when not in the plan", () => {
    const { secondarySubject: _drop, ...planNoSecondary } = planBase;
    // Replace shot 3 with one that doesn't use secondary_subject perspective
    const shot3Solo = { ...shot3, perspective: "observer" as const };
    const out = assembleSceneVideoPrompt(planNoSecondary, [shot1, shot2, shot3Solo]);
    expect(out.secondarySubject).toBeUndefined();
    expect(sceneVideoPromptSchema.safeParse(out).success).toBe(true);
  });

  it("omits secondarySubject when set to null in the plan", () => {
    const planNullSecondary = { ...planBase, secondarySubject: null };
    const shot3Solo = { ...shot3, perspective: "observer" as const };
    const out = assembleSceneVideoPrompt(planNullSecondary, [shot1, shot2, shot3Solo]);
    expect(out.secondarySubject).toBeUndefined();
  });

  it("throws when shots array is empty", () => {
    expect(() => assembleSceneVideoPrompt(planBase, [])).toThrow(/shots array is empty/);
  });

  it("throws when a planned shotNumber has no matching shot output", () => {
    expect(() => assembleSceneVideoPrompt(planBase, [shot1, shot2])).toThrow(
      /plan lists shotNumber 3 but no matching shot output/,
    );
  });

  it("throws when a shot has a shotNumber not in the plan", () => {
    const orphan = { ...shot1, shotNumber: 99 };
    expect(() => assembleSceneVideoPrompt(planBase, [shot1, shot2, shot3, orphan])).toThrow(
      /shotNumber 99 but the plan does not list it/,
    );
  });

  it("throws when assembled output fails scene-level refinement (main_subject without mainSubject)", () => {
    // Build a plan whose mainSubject is empty string (zod min(1) on plan
    // would catch it, so use a different tactic): construct directly.
    // Since shotPlanSchema requires mainSubject as a string, we test the
    // sceneVideoPromptSchema's own refine: a shot with main_subject
    // perspective and an empty scene-level mainSubject. We force this by
    // bypassing the plan schema and constructing inputs that pass plan
    // parse but expose the refine.
    const planEmptyMain = { ...planBase, mainSubject: "" };
    // Plan-level validation isn't done by the assembler — it trusts inputs
    // were validated upstream. The downstream sceneVideoPromptSchema.refine
    // catches: any shot with perspective=main_subject requires non-empty
    // mainSubject. Using empty string survives plan-level (it's still a
    // string) but the assembled output's refine should reject it.
    expect(() => assembleSceneVideoPrompt(planEmptyMain, [shot1, shot2, shot3])).toThrow(
      /sceneVideoPromptSchema validation/,
    );
  });

  it("preserves shot fields verbatim (no normalization)", () => {
    const out = assembleSceneVideoPrompt(planBase, [shot1, shot2, shot3]);
    const reconstructed = out.shots.find(s => s.shotNumber === 1);
    expect(reconstructed).toMatchObject({
      shotNumber: 1,
      purpose: "meet_character",
      duration: 4,
      description: shot1.description,
      cameraWork: shot1.cameraWork,
      perspective: "main_subject",
      perspectiveOf: "parvati",
      audio: shot1.audio,
      transition: "fade",
    });
  });

  it("computes per-shot firstFrameAnchor (visual continuity) and writes it on each shot", () => {
    const out = assembleSceneVideoPrompt(planBase, [shot1, shot2, shot3]);
    // Shot 1: first shot of scene → fresh.
    expect(out.shots.find(s => s.shotNumber === 1)?.firstFrameAnchor)
      .toEqual({ reason: 'fresh' });
    // Shot 2: transition=cut (soft), chains on shot 1's last frame.
    expect(out.shots.find(s => s.shotNumber === 2)?.firstFrameAnchor)
      .toEqual({ reason: 'continuity', sourceShotNumber: 1 });
    // Shot 3: also cut, chains on shot 2's last frame.
    expect(out.shots.find(s => s.shotNumber === 3)?.firstFrameAnchor)
      .toEqual({ reason: 'continuity', sourceShotNumber: 2 });
  });
});
