// Local stubs replacing deleted core/templates and parseAssetLines.
export interface GenericProjectFile { [k: string]: unknown }
export interface AssetEvent {
  kind: 'image' | 'video';
  filePath: string;
  metadata?: Record<string, unknown>;
}
