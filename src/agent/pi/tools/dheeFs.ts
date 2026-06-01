/**
 * Project-scoped filesystem tools for the dhee agent.
 *
 * Wraps `read`, `ls`, `grep`, `find` under `dhee_` names that REFUSE
 * any path outside the project directory. Replaces pi-coding-agent's
 * built-in versions, which accept any absolute path (and so let the
 * agent wander into engine source like `kshana-core/src/...` to debug
 * itself instead of helping the user with their video).
 *
 * Each tool takes `projectDir` explicitly (matching the other dhee_*
 * tools' contract). Scope check happens in `assertPathInProject`
 * before any IO.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve as pathResolve, relative } from 'node:path';
import { Type } from 'typebox';
import { defineTool } from '@mariozechner/pi-coding-agent';
import { assertPathInProject } from './scopeGuard.js';

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], details: {}, ...(isError ? { isError: true } : {}) };
}

// ── dhee_read ─────────────────────────────────────────────────────────
const ReadParams = Type.Object({
  projectDir: Type.String({ description: 'Absolute path to the project directory.' }),
  path: Type.String({
    description: "Absolute path to the file to read. Must be inside projectDir — paths outside are refused. For node outputs, prefer dhee_read_artifact (resolves the path via walkState).",
  }),
  maxBytes: Type.Optional(
    Type.Number({ description: 'Truncate output to this many bytes. Defaults to 64 KB.' }),
  ),
});

export function makeReadTool() {
  return defineTool({
    name: 'dhee_read',
    label: 'Read file',
    description:
      "Read a text file inside the project directory. Refuses any path outside projectDir. Output is truncated at maxBytes (default 64 KB). For bundle node outputs, use dhee_read_artifact instead.",
    parameters: ReadParams,
    async execute(_id, params) {
      try {
        assertPathInProject(params.projectDir, params.path);
      } catch (e) {
        return textResult(e instanceof Error ? e.message : String(e), true);
      }
      if (!existsSync(params.path)) {
        return textResult(`file not found: ${params.path}`, true);
      }
      const max = typeof params.maxBytes === 'number' ? params.maxBytes : 64 * 1024;
      let content: string;
      try {
        content = readFileSync(params.path, 'utf8');
      } catch (e) {
        return textResult(`read failed: ${e instanceof Error ? e.message : String(e)}`, true);
      }
      const truncated = content.length > max;
      const body = truncated ? content.slice(0, max) + `\n…(truncated at ${max} bytes)` : content;
      return textResult(body);
    },
  });
}

// ── dhee_ls ───────────────────────────────────────────────────────────
const LsParams = Type.Object({
  projectDir: Type.String({ description: 'Absolute path to the project directory.' }),
  path: Type.String({ description: 'Absolute path to the directory to list. Must be inside projectDir.' }),
});

export function makeLsTool() {
  return defineTool({
    name: 'dhee_ls',
    label: 'List directory',
    description: 'List the contents of a directory inside the project. Refuses paths outside projectDir.',
    parameters: LsParams,
    async execute(_id, params) {
      try {
        assertPathInProject(params.projectDir, params.path);
      } catch (e) {
        return textResult(e instanceof Error ? e.message : String(e), true);
      }
      if (!existsSync(params.path)) {
        return textResult(`directory not found: ${params.path}`, true);
      }
      let entries: string[];
      try {
        entries = readdirSync(params.path);
      } catch (e) {
        return textResult(`ls failed: ${e instanceof Error ? e.message : String(e)}`, true);
      }
      const out = entries.map((name) => {
        try {
          const full = pathResolve(params.path, name);
          const st = statSync(full);
          return st.isDirectory() ? `${name}/` : name;
        } catch {
          return name;
        }
      });
      return textResult(out.sort().join('\n'));
    },
  });
}

// ── dhee_grep ─────────────────────────────────────────────────────────
const GrepParams = Type.Object({
  projectDir: Type.String({ description: 'Absolute path to the project directory.' }),
  pattern: Type.String({ description: 'Regex pattern to match. Case-sensitive by default; pass caseInsensitive: true to relax.' }),
  path: Type.Optional(
    Type.String({ description: 'Absolute path to start from. Defaults to projectDir. Must be inside projectDir.' }),
  ),
  caseInsensitive: Type.Optional(Type.Boolean()),
  maxMatches: Type.Optional(Type.Number({ description: 'Stop after this many matching lines. Defaults to 100.' })),
});

export function makeGrepTool() {
  return defineTool({
    name: 'dhee_grep',
    label: 'Grep files',
    description: 'Search file contents under a project subdirectory for a regex pattern. Returns matching lines with file:line prefix. Refuses paths outside projectDir.',
    parameters: GrepParams,
    async execute(_id, params) {
      const start = params.path ?? params.projectDir;
      try {
        assertPathInProject(params.projectDir, start);
      } catch (e) {
        return textResult(e instanceof Error ? e.message : String(e), true);
      }
      if (!existsSync(start)) {
        return textResult(`path not found: ${start}`, true);
      }
      let re: RegExp;
      try {
        re = new RegExp(params.pattern, params.caseInsensitive ? 'i' : '');
      } catch (e) {
        return textResult(`bad regex: ${e instanceof Error ? e.message : String(e)}`, true);
      }
      const max = typeof params.maxMatches === 'number' ? params.maxMatches : 100;
      const out: string[] = [];
      const visit = (p: string): void => {
        if (out.length >= max) return;
        let st: ReturnType<typeof statSync>;
        try { st = statSync(p); } catch { return; }
        if (st.isDirectory()) {
          let entries: string[] = [];
          try { entries = readdirSync(p); } catch { return; }
          for (const name of entries) {
            if (name.startsWith('.')) continue; // skip dotfiles incl. .dhee/
            if (out.length >= max) return;
            visit(pathResolve(p, name));
          }
        } else if (st.isFile()) {
          // Heuristic skip of binaries to avoid 2GB image dumps.
          if (/\.(png|jpg|jpeg|webp|gif|mp4|mov|webm|mkv|wav|mp3|flac|safetensors|gguf|bin)$/i.test(p)) return;
          let lines: string[] = [];
          try { lines = readFileSync(p, 'utf8').split('\n'); } catch { return; }
          for (let i = 0; i < lines.length; i++) {
            if (out.length >= max) break;
            if (re.test(lines[i]!)) {
              const rel = relative(params.projectDir, p);
              out.push(`${rel}:${i + 1}:${lines[i]}`);
            }
          }
        }
      };
      visit(start);
      return textResult(out.length > 0 ? out.join('\n') : `(no matches for /${params.pattern}/)`);
    },
  });
}

// ── dhee_find ─────────────────────────────────────────────────────────
const FindParams = Type.Object({
  projectDir: Type.String({ description: 'Absolute path to the project directory.' }),
  pattern: Type.String({ description: 'Glob pattern (e.g. "*.png" or "assets/images/**.png").' }),
  path: Type.Optional(
    Type.String({ description: 'Absolute path to start from. Defaults to projectDir. Must be inside projectDir.' }),
  ),
  maxResults: Type.Optional(Type.Number({ description: 'Cap on returned matches. Defaults to 200.' })),
});

function globToRegex(pattern: string): RegExp {
  // Minimal glob → regex: ** → any (including /), * → any except /,
  // ? → single char. Other regex metachars escaped.
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      out += '.*';
      i += 2;
    } else if (c === '*') {
      out += '[^/]*';
      i += 1;
    } else if (c === '?') {
      out += '[^/]';
      i += 1;
    } else if (/[.+^${}()|[\]\\]/.test(c!)) {
      out += '\\' + c;
      i += 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}

export function makeFindTool() {
  return defineTool({
    name: 'dhee_find',
    label: 'Find files',
    description: 'List files under a project subdirectory matching a glob pattern (e.g. "**/*.png"). Refuses paths outside projectDir.',
    parameters: FindParams,
    async execute(_id, params) {
      const start = params.path ?? params.projectDir;
      try {
        assertPathInProject(params.projectDir, start);
      } catch (e) {
        return textResult(e instanceof Error ? e.message : String(e), true);
      }
      if (!existsSync(start)) {
        return textResult(`path not found: ${start}`, true);
      }
      const re = globToRegex(params.pattern);
      const max = typeof params.maxResults === 'number' ? params.maxResults : 200;
      const out: string[] = [];
      const visit = (p: string): void => {
        if (out.length >= max) return;
        let st: ReturnType<typeof statSync>;
        try { st = statSync(p); } catch { return; }
        if (st.isDirectory()) {
          let entries: string[] = [];
          try { entries = readdirSync(p); } catch { return; }
          for (const name of entries) {
            if (name.startsWith('.')) continue;
            if (out.length >= max) return;
            visit(pathResolve(p, name));
          }
        } else if (st.isFile()) {
          const rel = relative(params.projectDir, p);
          if (re.test(rel)) out.push(rel);
        }
      };
      visit(start);
      return textResult(out.length > 0 ? out.sort().join('\n') : `(no files match ${params.pattern})`);
    },
  });
}

export const dheeReadTool = makeReadTool();
export const dheeLsTool = makeLsTool();
export const dheeGrepTool = makeGrepTool();
export const dheeFindTool = makeFindTool();
