/**
 * Per-project feature flags — read from `project.json` under the
 * `features` object. See docs/feature-flags.md for the registry and
 * conventions.
 *
 * Most flags are STRICT opt-IN booleans (only the literal `true`
 * enables). `gateAfterCollections` is the exception: it is opt-OUT and
 * defaults ON, so only an explicit `false` disables it. The legacy
 * executor's feature-flag plumbing (projectTypes.ts /
 * createProjectInProcess.ts / isSkipHoldingBeatLFEnabled) was removed
 * in the bundle migration; this is the surviving reader for the bundle
 * architecture.
 */

/** Shape of the slice of project.json this module reads. */
export interface ProjectFeatures {
  /**
   * Stop-after-each-collection gate. **Defaults ON** — a bundle walk
   * halts after each collection node finishes a pass that did real
   * work, so the user can inspect each fan-out batch and Resume to
   * continue. Opt-out: set to `false` to run straight through. Read by
   * runProjectViaBundle, which forwards it to the walker's
   * `gateAfterCollections`. Default flipped to ON 2026-06-06.
   */
  gateAfterCollections?: unknown;
}

interface ProjectWithFeatures {
  features?: ProjectFeatures;
}

/**
 * Stop-after-each-collection gate state. **Defaults ON**: returns
 * `false` ONLY when `project.features.gateAfterCollections === false`
 * (explicit opt-out). Missing field, missing `features`, or a
 * non-boolean value → enabled. Legacy projects (no field) therefore
 * gate by default too.
 */
export function isGateAfterCollectionsEnabled(project: unknown): boolean {
  if (project && typeof project === 'object') {
    const features = (project as ProjectWithFeatures).features;
    if (features && typeof features === 'object') {
      return features.gateAfterCollections !== false;
    }
  }
  return true;
}
