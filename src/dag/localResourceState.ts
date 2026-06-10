export type LocalResourceKind = 'local_comfy' | 'local_llm';

export interface LocalResourceSnapshot {
  kind: LocalResourceKind;
  tool?: string;
  nodeId?: string;
  itemId?: string;
  resourceKey?: string;
  startedAt: number;
}

type LocalResourceSlot = LocalResourceSnapshot & { token: symbol };
type LocalResourceStartListener = (resource: LocalResourceSnapshot) => void | Promise<void>;

let currentResource: LocalResourceSlot | null = null;
const localResourceStartListeners = new Set<LocalResourceStartListener>();

export function getCurrentLocalResource(): LocalResourceSnapshot | null {
  if (!currentResource) return null;
  return {
    kind: currentResource.kind,
    ...(currentResource.tool !== undefined ? { tool: currentResource.tool } : {}),
    ...(currentResource.nodeId !== undefined ? { nodeId: currentResource.nodeId } : {}),
    ...(currentResource.itemId !== undefined ? { itemId: currentResource.itemId } : {}),
    ...(currentResource.resourceKey !== undefined ? { resourceKey: currentResource.resourceKey } : {}),
    startedAt: currentResource.startedAt,
  };
}

export async function withLocalResource<T>(
  resource: Omit<LocalResourceSnapshot, 'startedAt'> & { startedAt?: number },
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = resource.startedAt ?? Date.now();
  const snapshot: LocalResourceSnapshot = {
    kind: resource.kind,
    ...(resource.tool !== undefined ? { tool: resource.tool } : {}),
    ...(resource.nodeId !== undefined ? { nodeId: resource.nodeId } : {}),
    ...(resource.itemId !== undefined ? { itemId: resource.itemId } : {}),
    ...(resource.resourceKey !== undefined ? { resourceKey: resource.resourceKey } : {}),
    startedAt,
  };

  for (const listener of localResourceStartListeners) {
    await listener(snapshot);
  }

  const token = Symbol(resource.kind);
  currentResource = {
    ...snapshot,
    token,
  };

  try {
    return await fn();
  } finally {
    if (currentResource?.token === token) {
      currentResource = null;
    }
  }
}

export function addLocalResourceStartListener(
  listener: LocalResourceStartListener,
): () => void {
  localResourceStartListeners.add(listener);
  return () => {
    localResourceStartListeners.delete(listener);
  };
}

export function __resetLocalResourceForTesting(): void {
  currentResource = null;
  localResourceStartListeners.clear();
}
