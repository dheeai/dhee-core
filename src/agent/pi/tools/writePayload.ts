/**
 * Discriminated-union payload shared by `dhee_write_input` and
 * `dhee_write_node_content`.
 *
 *   { kind: 'text',      content: string }
 *   | { kind: 'base64',  contentBase64: string }
 *   | { kind: 'localFile', sourcePath: string }
 *
 * `localFile` lets the desktop hand the agent a path to an
 * attachment it has staged under <projectDir>/.dhee/attachments/...
 * without burning tokens on a base64 blob.
 *
 * `resolveWritePayload` is the only sanctioned way to turn one of
 * these into bytes-on-disk-bound. Tools call it, then `writeFileSync`
 * the result.
 */
import { existsSync, readFileSync } from 'node:fs';
import { Type } from 'typebox';

export type WritePayload =
  | { kind: 'text'; content: string }
  | { kind: 'base64'; contentBase64: string }
  | { kind: 'localFile'; sourcePath: string };

/**
 * TypeBox schema fragment so the tools can re-export it for their
 * own `parameters` shape without duplicating field declarations.
 */
export const WritePayloadSchema = Type.Union([
  Type.Object({
    kind: Type.Literal('text'),
    content: Type.String({
      description:
        'Inline UTF-8 text content. Use this for prompts, JSON, and small text artifacts.',
    }),
  }),
  Type.Object({
    kind: Type.Literal('base64'),
    contentBase64: Type.String({
      description:
        "Base64-encoded bytes. Use for small binary content the user pasted into chat. For larger files prefer kind='localFile'.",
    }),
  }),
  Type.Object({
    kind: Type.Literal('localFile'),
    sourcePath: Type.String({
      description:
        'Absolute path to a file on the local filesystem. The tool reads the bytes and writes them to the target location. Used for chat attachments staged under .dhee/attachments/.',
    }),
  }),
]);

export function resolveWritePayload(payload: WritePayload): Buffer {
  switch (payload.kind) {
    case 'text': {
      if (typeof payload.content !== 'string') {
        throw new Error("payload.kind='text' requires a string `content` field.");
      }
      return Buffer.from(payload.content, 'utf8');
    }
    case 'base64': {
      if (typeof payload.contentBase64 !== 'string') {
        throw new Error("payload.kind='base64' requires a string `contentBase64` field.");
      }
      // Validate that the input is base64-shaped. Node's Buffer.from
      // is lenient — it silently drops invalid chars — so we add a
      // pre-flight regex check to catch obviously-bogus inputs before
      // they slip through as empty/garbled writes.
      if (!/^[A-Za-z0-9+/=\s]*$/.test(payload.contentBase64)) {
        throw new Error('contentBase64 contains characters outside the base64 alphabet.');
      }
      return Buffer.from(payload.contentBase64, 'base64');
    }
    case 'localFile': {
      if (typeof payload.sourcePath !== 'string') {
        throw new Error("payload.kind='localFile' requires a string `sourcePath` field.");
      }
      if (!existsSync(payload.sourcePath)) {
        throw new Error(`sourcePath not found: ${payload.sourcePath} (ENOENT).`);
      }
      return readFileSync(payload.sourcePath);
    }
    default: {
      const k = (payload as { kind?: string }).kind;
      throw new Error(`unknown payload kind '${k ?? '(undefined)'}'. Expected one of: text, base64, localFile.`);
    }
  }
}
