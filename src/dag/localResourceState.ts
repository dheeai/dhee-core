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

let currentResource: LocalResourceSlot | null = null;

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
  const token = Symbol(resource.kind);
  currentResource = {
    ...resource,
    startedAt: resource.startedAt ?? Date.now(),
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

export function __resetLocalResourceForTesting(): void {
  currentResource = null;
}
