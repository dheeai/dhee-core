/**
 * API Key Authentication for remote mode.
 *
 * In remote mode, clients must provide a valid API key to connect.
 * Keys are loaded from the dhee_API_KEYS environment variable
 * (comma-separated) or from a config file.
 *
 * Co-located mode (localhost) skips auth entirely.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export interface ApiKeyEntry {
  key: string;
  clientId: string;
  label?: string;
}

/**
 * Load API keys from environment variable or config file.
 */
export function loadApiKeys(): ApiKeyEntry[] {
  const keys: ApiKeyEntry[] = [];

  // 1. Environment variable: dhee_API_KEYS=key1:client1,key2:client2
  const envKeys = process.env['dhee_API_KEYS'];
  if (envKeys) {
    for (const entry of envKeys.split(',')) {
      const trimmed = entry.trim();
      if (!trimmed) continue;

      const [key, clientId] = trimmed.split(':');
      if (key) {
        keys.push({
          key: key.trim(),
          clientId: clientId?.trim() || `client_${keys.length + 1}`,
        });
      }
    }
  }

  // 2. Config file: .dhee-keys.json
  const configFile = join(process.cwd(), '.dhee-keys.json');
  if (existsSync(configFile)) {
    try {
      const content = readFileSync(configFile, 'utf-8');
      const fileKeys = JSON.parse(content) as ApiKeyEntry[];
      if (Array.isArray(fileKeys)) {
        for (const entry of fileKeys) {
          if (entry.key && entry.clientId) {
            keys.push(entry);
          }
        }
      }
    } catch {
      console.warn('Warning: Could not parse .dhee-keys.json');
    }
  }

  return keys;
}

/**
 * API key authenticator.
 */
export class ApiKeyAuth {
  private keys: Map<string, ApiKeyEntry>;

  constructor(keys?: ApiKeyEntry[]) {
    this.keys = new Map();
    const loaded = keys ?? loadApiKeys();
    for (const entry of loaded) {
      this.keys.set(entry.key, entry);
    }
  }

  /**
   * Validate an API key. Returns the entry if valid, null otherwise.
   */
  validate(apiKey: string): ApiKeyEntry | null {
    return this.keys.get(apiKey) ?? null;
  }

  /**
   * Check if authentication is configured (i.e., any keys are loaded).
   */
  isConfigured(): boolean {
    return this.keys.size > 0;
  }

  /**
   * Get number of configured keys.
   */
  keyCount(): number {
    return this.keys.size;
  }
}

/**
 * Check if a connection should skip authentication.
 * Returns true for localhost connections in 'local' or 'auto' mode.
 */
export function shouldSkipAuth(
  remoteAddress: string | undefined,
  serverMode: 'local' | 'remote' | 'auto',
): boolean {
  if (serverMode === 'local') {
    return true;
  }

  if (serverMode === 'auto' && remoteAddress) {
    const localAddresses = ['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost'];
    return localAddresses.includes(remoteAddress);
  }

  return false;
}
