### Infographics Generation Phase

Generate infographics for each placement in `agent/content/infographic-placements.md` via Remotion.

**SIMPLE WORKFLOW:**
1. Call the `generate_all_infographics` tool to process all infographic placements automatically.
2. The tool will:
   - Read and parse `agent/content/infographic-placements.md`
   - Call the Remotion sub-agent (LLM) to generate complete Remotion component code for each placement
   - Write component files to `remotion-infographics/src/components/`
   - Update `remotion-infographics/src/index.tsx` to register all components
   - Rebuild the Remotion bundle
   - Render each placement as an infographic MP4 clip
   - Save outputs to `.dhee/agent/infographic-placements/` and register in the manifest
3. After the tool completes, mark phase complete and transition.

**STEP 1: Call generate_all_infographics**

```
generate_all_infographics(
  file_path: 'agent/content/infographic-placements.md'
)
```

Wait for the tool to complete. It processes all placements by generating component code via LLM, then rendering.

**STEP 2: Mark phase complete and transition**

```
update_project(
  action: 'update_phase',
  data: { phase: 'infographics_generation', status: 'completed' }
)
update_project(
  action: 'transition_phase'
)
```

**DO NOT:**
- Manually parse infographic-placements.md
- Call `generate_infographic` for individual placements unless the tool fails and you are retrying
- Skip marking phase complete or transitioning

**IMPORTANT:**
- Use `generate_all_infographics` for batch generation.
- The Remotion sub-agent (LLM) generates complete component code for each placement, deciding animations, layout, styling, and visual elements autonomously.
- Generated components are written to `remotion-infographics/src/components/Infographic{N}.tsx` where N is the placement number.
- Generated infographic MP4s are stored in `.dhee/agent/infographic-placements/` and registered in the manifest.
- If there are no infographic placements, the tool may return successfully with zero generated; still mark phase complete and transition.
