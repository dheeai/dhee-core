/**
 * gateRunResult — the message `dhee_run_bundle` returns to the agent
 * when a run paused on the stop-after-each-collection gate (instead of
 * running end-to-end).
 *
 * Kept as a pure builder in its own module (per the repo convention of
 * authoring agent-facing copy separately) so the wording is unit-
 * testable without the runner/tool stack, and so the desktop's
 * non-blocking re-wake nudge can mirror it.
 *
 * The whole point (issue #133): make the gate the FIRST-CLASS reason the
 * agent reads. Before this, the tool returned a generic "completed", the
 * agent saw downstream nodes produced nothing, and confabulated a cause
 * ("ComfyUI likely not configured") — then offered an irrelevant fix.
 * This message states the real reason and the correct next step (resume,
 * or turn the gate off), and names what's still pending so the agent
 * doesn't have to guess.
 */

export interface GateRunResultOpts {
  /** The collection node id the run halted after. */
  gatedAfter: string;
  /** Downstream node ids that still need to run (topo order). Optional. */
  pendingAfterGate?: string[];
}

export function buildGateRunResult(opts: GateRunResultOpts): string {
  const pending = opts.pendingAfterGate ?? [];
  const pendingLine =
    pending.length > 0
      ? ` Stages still pending behind the gate: ${pending.join(', ')}.`
      : '';
  return (
    `Run PAUSED after collection '${opts.gatedAfter}' because the ` +
    `"Stop after each collection" gate (gateAfterCollections) is enabled — ` +
    `this is an intentional, by-design pause, NOT a failure or a missing ` +
    `configuration.${pendingLine} The downstream stages have not run yet ` +
    `because of the gate, so do NOT attribute the missing output to a ` +
    `missing endpoint (e.g. ComfyUI). Tell the user the batch is ready to ` +
    `review, then resume the run (dhee_start_run / dhee_run_bundle again) ` +
    `to continue, or turn the gate off for an end-to-end run.`
  );
}
