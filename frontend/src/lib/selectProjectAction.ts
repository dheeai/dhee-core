/**
 * Shared project-selection action used by both the header dropdown
 * (ProjectSelector) and the `/project` slash command. Mirrors the
 * dropdown's hydration steps so a chat-driven pick gets the same
 * panels populated as a click pick.
 */
import type { ExecutorNodeInfo } from "./store";
import { synthesizeNodesFromAssets, todosFromNodes, type ManifestAsset } from "./synthesizeNodesFromAssets";
import { synthesizeNodesFromScenes, type SceneLike } from "./synthesizeNodesFromScenes";

type Dispatch = (action: { type: string; [k: string]: unknown }) => void;
type Send = (msg: Record<string, unknown>) => void;

export async function selectProjectByName(
  name: string,
  dispatch: Dispatch,
  send: Send,
): Promise<{ ok: boolean; reason?: string }> {
  const projectName = name.replace(/\.dhee$/, "");
  const dirName = `${projectName}.dhee`;

  dispatch({ type: "SELECT_PROJECT", name: projectName });
  send({ type: "select_project", data: { projectName } });

  let hydratedFromExecutorState = false;

  try {
    const stateRes = await fetch(`/api/v1/projects/${projectName}`);
    if (stateRes.ok) {
      const data = await stateRes.json();
      if (data.currentPhase) {
        dispatch({ type: "SET_PHASE", phase: data.currentPhase });
      }
      // Hydration priority: project.scenes (new SoT) → executorState.nodes
      // (legacy graph) → manifest synthesis (last resort, set up below).
      if (Array.isArray(data.scenes) && data.scenes.length > 0) {
        const scenesMap = synthesizeNodesFromScenes(data.scenes as SceneLike[]);
        if (Object.keys(scenesMap).length > 0) {
          dispatch({ type: "SET_NODES", nodes: scenesMap });
          dispatch({ type: "SET_TODOS", todos: todosFromNodes(scenesMap) });
          hydratedFromExecutorState = true;
        }
      }
      if (!hydratedFromExecutorState && data.executorState?.nodes) {
        const rawNodes = data.executorState.nodes as Record<string, {
          id: string;
          displayName?: string;
          status?: string;
          typeId: string;
          itemId?: string;
          outputPath?: string;
          outputPaths?: Record<string, string>;
        }>;
        const nodeMap: Record<string, ExecutorNodeInfo> = {};
        for (const [id, n] of Object.entries(rawNodes)) {
          nodeMap[id] = {
            id,
            typeId: n.typeId,
            itemId: n.itemId,
            displayName: n.displayName,
            status: (n.status ?? "pending") as
              | "pending"
              | "in_progress"
              | "completed"
              | "failed",
            outputPath: n.outputPath,
            outputPaths: n.outputPaths,
          };
        }
        dispatch({ type: "SET_NODES", nodes: nodeMap });
        dispatch({ type: "SET_TODOS", todos: todosFromNodes(nodeMap) });
        hydratedFromExecutorState = true;
      }
    } else if (stateRes.status === 404) {
      return { ok: false, reason: `Project '${projectName}' not found.` };
    }
  } catch {
    /* state fetch is best-effort */
  }

  try {
    const assetsRes = await fetch(`/api/v1/projects/${projectName}/assets`);
    if (assetsRes.ok) {
      const data = await assetsRes.json();
      const rawAssets = (data.assets || []) as ManifestAsset[];
      const assets = rawAssets.map((a) => ({
        ...a,
        url: `/api/v1/assets/${projectName}/${a.path}`,
      }));
      dispatch({ type: "SET_ASSETS", assets });

      // Pi-era projects have no executorState — synthesize a node map from
      // the asset manifest so the Storyboard / Todos panels populate.
      if (!hydratedFromExecutorState) {
        const synth = synthesizeNodesFromAssets(rawAssets);
        if (Object.keys(synth).length > 0) {
          dispatch({ type: "SET_NODES", nodes: synth });
          dispatch({ type: "SET_TODOS", todos: todosFromNodes(synth) });
        }
      }
    }
  } catch {
    /* assets fetch is best-effort */
  }

  void dirName;
  return { ok: true };
}
