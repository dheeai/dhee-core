/**
 * listVersions — the candidate tray for a node (and optional itemId).
 *
 * Pure fold over an event log. Returns the full ordered list of
 * versions produced for the instance, with `selected: true` set on
 * the currently-selected one (default = latest; overridden by the most
 * recent `version.selected` event).
 *
 * This is what backs the agent's `dheeListVersions` tool and (later)
 * the desktop's candidate tray UI. Versions are NEVER removed from the
 * tray; they only become unselected.
 */
import type {
  DheeEvent,
  NodeCompletedPayload,
  VersionSelectedPayload,
} from './events.js';
import { branchVisibilityFilter } from './branchFilter.js';

export interface VersionTrayEntry {
  versionId: string;
  outputPath: string;
  selected: boolean;
  createdAt: number;
  artifact?: NodeCompletedPayload['artifact'];
  generation?: NodeCompletedPayload['generation'];
}

export interface ListVersionsOpts {
  branchId?: string;
}

export function listVersions(
  events: Iterable<DheeEvent>,
  nodeId: string,
  itemId?: string,
  opts: ListVersionsOpts = {},
): VersionTrayEntry[] {
  const branch = opts.branchId ?? 'main';
  const versions: VersionTrayEntry[] = [];
  let selectedId: string | undefined;
  const eventList = [...events];
  const visible = branchVisibilityFilter(eventList, branch);

  for (const e of eventList) {
    if (!visible(e)) continue;

    if (e.kind === 'node.completed') {
      const p = e.payload as NodeCompletedPayload;
      if (p.nodeId !== nodeId) continue;
      if ((p.itemId ?? undefined) !== (itemId ?? undefined)) continue;
      versions.push({
        versionId: p.versionId,
        outputPath: p.outputPath,
        selected: false,
        createdAt: e.ts,
        ...(p.artifact ? { artifact: p.artifact } : {}),
        ...(p.generation ? { generation: p.generation } : {}),
      });
      selectedId = p.versionId; // latest auto-selects until overridden
    } else if (e.kind === 'version.selected') {
      const p = e.payload as VersionSelectedPayload;
      if (p.nodeId !== nodeId) continue;
      if ((p.itemId ?? undefined) !== (itemId ?? undefined)) continue;
      // Only flip if the version actually exists in the tray.
      if (versions.some((v) => v.versionId === p.versionId)) {
        selectedId = p.versionId;
      }
    }
  }

  return versions.map((v) => ({ ...v, selected: v.versionId === selectedId }));
}
