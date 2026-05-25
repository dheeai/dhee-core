/**
 * Web UI routes - serves the SPA and project/asset REST endpoints.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'fs';
import { join, extname } from 'path';
import { scanProjects } from '../tasks/video/workflow/ProjectManager.js';
import { getWebUIHtml } from './webui.js';
import { builtInTemplates, initializeTemplates } from '../templates/index.js';
import {
  isAllowedCharacterImageFilename,
  sanitizeUploadFilename,
  uniqueFilename,
} from './characterReferenceUploads.js';

const DURATION_PRESETS: Record<string, { label: string; seconds: number }[]> = {
  short: [
    { label: '15 seconds', seconds: 15 },
    { label: '30 seconds', seconds: 30 },
    { label: '45 seconds', seconds: 45 },
    { label: '60 seconds', seconds: 60 },
  ],
  infomercial: [
    { label: '1 minute', seconds: 60 },
    { label: '1.5 minutes', seconds: 90 },
    { label: '2 minutes', seconds: 120 },
    { label: '3 minutes', seconds: 180 },
  ],
  narrative: [
    { label: '1 minute', seconds: 60 },
    { label: '2 minutes', seconds: 120 },
    { label: '3 minutes', seconds: 180 },
    { label: '5 minutes', seconds: 300 },
  ],
  documentary: [
    { label: '2 minutes', seconds: 120 },
    { label: '3 minutes', seconds: 180 },
    { label: '5 minutes', seconds: 300 },
    { label: '10 minutes', seconds: 600 },
  ],
  graphic_novel: [
    { label: '8 panels', seconds: 8 },
    { label: '16 panels', seconds: 16 },
    { label: '24 panels', seconds: 24 },
    { label: '32 panels', seconds: 32 },
  ],
};

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.json': 'application/json',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

/**
 * Register web UI routes on the Fastify instance.
 * Serves the React frontend build from frontend/dist/ if available,
 * otherwise falls back to the inline SPA from webui.ts.
 */
export async function registerWebUIRoutes(app: FastifyInstance): Promise<void> {
  // Check for React frontend build
  const reactDistDir = join(process.cwd(), 'frontend', 'dist');
  const reactIndexPath = join(reactDistDir, 'index.html');
  const hasReactBuild = existsSync(reactIndexPath);

  if (hasReactBuild) {
    // Serve React frontend static assets (JS, CSS, etc.)
    const assetsDir = join(reactDistDir, 'assets');
    if (existsSync(assetsDir)) {
      app.get<{ Params: { '*': string } }>(
        '/assets/*',
        async (request: FastifyRequest<{ Params: { '*': string } }>, reply: FastifyReply) => {
          const filePath = request.params['*'];
          if (filePath.includes('..')) return reply.status(400).send({ error: 'Invalid path' });
          const fullPath = join(assetsDir, filePath);
          if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
            return reply.status(404).send({ error: 'Not found' });
          }
          const ext = extname(fullPath).toLowerCase();
          const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
          return reply.type(contentType).send(readFileSync(fullPath));
        },
      );
    }

    // Serve previews and other static directories from dist/
    const previewsDir = join(reactDistDir, 'previews');
    if (existsSync(previewsDir)) {
      app.get<{ Params: { '*': string } }>(
        '/previews/*',
        async (request: FastifyRequest<{ Params: { '*': string } }>, reply: FastifyReply) => {
          const filePath = request.params['*'];
          if (filePath.includes('..')) return reply.status(400).send({ error: 'Invalid path' });
          const fullPath = join(previewsDir, filePath);
          if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
            return reply.status(404).send({ error: 'Not found' });
          }
          const ext = extname(fullPath).toLowerCase();
          const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
          return reply.type(contentType).send(readFileSync(fullPath));
        },
      );
    }

    // Serve favicon and other root-level static files
    app.get('/favicon.png', async (_request: FastifyRequest, reply: FastifyReply) => {
      const faviconPath = join(reactDistDir, 'favicon.png');
      if (existsSync(faviconPath)) {
        return reply.type('image/png').send(readFileSync(faviconPath));
      }
      return reply.status(404).send();
    });
    app.get('/favicon.svg', async (_request: FastifyRequest, reply: FastifyReply) => {
      const faviconPath = join(reactDistDir, 'favicon.svg');
      if (existsSync(faviconPath)) {
        return reply.type('image/svg+xml').send(readFileSync(faviconPath));
      }
      return reply.status(404).send();
    });
  }

  // SPA fallback: serve React index.html or inline SPA
  const serveSPA = async (_request: FastifyRequest, reply: FastifyReply) => {
    if (hasReactBuild) {
      return reply.type('text/html').send(readFileSync(reactIndexPath, 'utf-8'));
    }
    return reply.type('text/html').send(getWebUIHtml());
  };
  app.get('/', serveSPA);
  app.get('/web', serveSPA);

  // List all projects
  app.get('/api/v1/projects', async (_request: FastifyRequest, reply: FastifyReply) => {
    const projects = scanProjects();
    return reply.send({ projects });
  });

  // Get a specific project's project.json
  app.get<{ Params: { name: string } }>(
    '/api/v1/projects/:name',
    async (request: FastifyRequest<{ Params: { name: string } }>, reply: FastifyReply) => {
      const { name } = request.params;
      const projectDir = join(process.cwd(), `${name}.dhee`);
      const projectFile = join(projectDir, 'project.json');

      if (!existsSync(projectFile)) {
        return reply.status(404).send({ error: 'Project not found', name });
      }

      try {
        const data = JSON.parse(readFileSync(projectFile, 'utf-8'));
        return reply.send(data);
      } catch {
        return reply.status(500).send({ error: 'Failed to read project file' });
      }
    }
  );

  // List assets for a project
  app.get<{ Params: { name: string } }>(
    '/api/v1/projects/:name/assets',
    async (request: FastifyRequest<{ Params: { name: string } }>, reply: FastifyReply) => {
      const { name } = request.params;
      const manifestPath = join(process.cwd(), `${name}.dhee`, 'assets', 'manifest.json');

      if (!existsSync(manifestPath)) {
        return reply.send({ assets: [] });
      }

      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        const allAssets = manifest.assets ?? [];

        // Filter + enrich: drop assets whose `path` is no longer referenced
        // by any node's outputPath/outputPaths (e.g. cleared by a reset), and
        // attach `nodeId`/`frame` for storyboard grouping + redo. See
        // `filterLiveAssets` for the full rationale.
        const projectPath = join(process.cwd(), `${name}.dhee`, 'project.json');
        let assets = allAssets;
        if (existsSync(projectPath)) {
          try {
            const project = JSON.parse(readFileSync(projectPath, 'utf-8'));
            const nodes = project.executorState?.nodes ?? {};
            const { filterLiveAssets } = await import('./assetFilter.js');
            assets = filterLiveAssets(allAssets, nodes);
          } catch { /* non-fatal */ }
        }

        return reply.send({ assets });
      } catch {
        return reply.send({ assets: [] });
      }
    }
  );

  // Load prompt data for a node (for Edit & Redo modal)
  app.get<{ Params: { name: string; nodeId: string } }>(
    '/api/v1/projects/:name/node-prompt/:nodeId',
    async (request: FastifyRequest<{ Params: { name: string; nodeId: string } }>, reply: FastifyReply) => {
      const { name, nodeId } = request.params;
      const projectPath = join(process.cwd(), `${name}.dhee`, 'project.json');

      if (!existsSync(projectPath)) {
        return reply.status(404).send({ error: 'Project not found' });
      }

      try {
        const { resolveNodePromptPath, getAvailableReferences, stripMarkdownFences } = await import('./editAndRedo.js');
        const { resolveSchemaNodePrompt } = await import('./resolveSchemaNodePrompt.js');
        const project = JSON.parse(readFileSync(projectPath, 'utf-8'));
        const nodes = project.executorState?.nodes ?? {};
        const node = nodes[nodeId];

        if (!node) {
          // Pi-era fallback: synthesize the modal's expected shape from
          // project.scenes when the legacy node graph isn't there.
          const synthesized = resolveSchemaNodePrompt(project, nodeId);
          if (synthesized) {
            // Prefer the on-disk prompt file when it exists — it carries the
            // original frames + references structure the Edit modal expects.
            // Fall back to the synthesized minimal shape otherwise.
            let prompt: Record<string, unknown> = synthesized.prompt;
            if (synthesized.promptFilePath) {
              const absPath = join(process.cwd(), `${name}.dhee`, synthesized.promptFilePath);
              if (existsSync(absPath)) {
                try {
                  const raw = readFileSync(absPath, 'utf-8');
                  prompt = JSON.parse(stripMarkdownFences(raw)) as Record<string, unknown>;
                } catch { /* fall back to synthesized */ }
              }
            }
            const response: Record<string, unknown> = {
              nodeId: synthesized.nodeId,
              nodeType: synthesized.nodeType,
              prompt,
            };
            if (synthesized.firstFramePath) {
              response['firstFrameUrl'] = `/api/v1/assets/${name}/${synthesized.firstFramePath}`;
            }
            return reply.send(response);
          }
          return reply.status(404).send({ error: `Node not found: ${nodeId}` });
        }

        const promptPath = resolveNodePromptPath(nodeId, nodes);
        let prompt: Record<string, unknown> = {};

        if (promptPath) {
          const absPath = join(process.cwd(), `${name}.dhee`, promptPath);
          if (existsSync(absPath)) {
            try {
              const raw = readFileSync(absPath, 'utf-8');
              prompt = JSON.parse(stripMarkdownFences(raw));
            } catch { /* empty */ }
          }
        }

        const response: Record<string, unknown> = {
          nodeId,
          nodeType: node.typeId,
          prompt,
        };

        // For shot images: include available references
        if (node.typeId === 'shot_image') {
          response['availableReferences'] = getAvailableReferences(nodes, name);
        }

        // For shot videos: include first frame URL for preview
        if (node.typeId === 'shot_video') {
          const shotImageNode = nodes[`shot_image:${node.itemId}`];
          if (shotImageNode?.outputPath) {
            response['firstFrameUrl'] = `/api/v1/assets/${name}/${shotImageNode.outputPath}`;
          }
        }

        return reply.send(response);
      } catch (err) {
        return reply.status(500).send({ error: (err as Error).message });
      }
    }
  );

  // Serve static asset files from project directories
  app.get<{ Params: { project: string; '*': string } }>(
    '/api/v1/assets/:project/*',
    async (request: FastifyRequest<{ Params: { project: string; '*': string } }>, reply: FastifyReply) => {
      const { project } = request.params;
      const filePath = request.params['*'];

      // Prevent path traversal
      if (filePath.includes('..')) {
        return reply.status(400).send({ error: 'Invalid path' });
      }

      const fullPath = join(process.cwd(), `${project}.dhee`, filePath);

      if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
        return reply.status(404).send({ error: 'Asset not found' });
      }

      const ext = extname(fullPath).toLowerCase();
      const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';

      const fileBuffer = readFileSync(fullPath);
      return reply.type(contentType).send(fileBuffer);
    }
  );

  // Upload a character-reference image to the staging uploads/ dir.
  app.post<{ Querystring: { filename: string } }>(
    '/api/v1/upload',
    {
      config: {},
    },
    async (request: FastifyRequest<{ Querystring: { filename: string } }>, reply: FastifyReply) => {
      const filename = request.query.filename;
      if (!filename) {
        return reply.status(400).send({ error: 'filename query param required' });
      }
      if (!isAllowedCharacterImageFilename(filename)) {
        return reply.status(415).send({ error: 'Only image uploads are supported' });
      }

      const safeName = sanitizeUploadFilename(filename);
      const uploadDir = join(process.cwd(), 'uploads');
      if (!existsSync(uploadDir)) mkdirSync(uploadDir, { recursive: true });

      const storedName = uniqueFilename(uploadDir, safeName);
      const destPath = join(uploadDir, storedName);
      const rawBody = request.body;
      const body = Buffer.isBuffer(rawBody)
        ? rawBody
        : Buffer.from(typeof rawBody === 'string' ? rawBody : '');
      writeFileSync(destPath, body);

      return reply.send({
        name: filename,
        path: destPath,
        url: `/api/v1/uploads/${storedName}`,
      });
    }
  );

  // Serve uploaded files
  app.get<{ Params: { '*': string } }>(
    '/api/v1/uploads/*',
    async (request: FastifyRequest<{ Params: { '*': string } }>, reply: FastifyReply) => {
      const filePath = request.params['*'];
      if (filePath.includes('..')) {
        return reply.status(400).send({ error: 'Invalid path' });
      }
      const fullPath = join(process.cwd(), 'uploads', filePath);
      if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
        return reply.status(404).send({ error: 'File not found' });
      }
      const ext = extname(fullPath).toLowerCase();
      const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
      return reply.type(contentType).send(readFileSync(fullPath));
    }
  );

  // Get all templates with styles and duration presets
  app.get('/api/v1/templates', async (_request: FastifyRequest, reply: FastifyReply) => {
    initializeTemplates();
    const templates = builtInTemplates.map(t => ({
      id: t.id,
      displayName: t.displayName,
      description: t.description,
      defaultStyle: t.defaultStyle,
      styles: (t.styles || []).map((s: any) => ({
        id: s.id,
        displayName: s.displayName,
        description: s.description,
      })),
    }));
    return reply.send({ templates, durationPresets: DURATION_PRESETS });
  });

  // List image files in a project's assets directory (for browsing without manifest)
  app.get<{ Params: { name: string } }>(
    '/api/v1/projects/:name/images',
    async (request: FastifyRequest<{ Params: { name: string } }>, reply: FastifyReply) => {
      const { name } = request.params;
      const imagesDir = join(process.cwd(), `${name}.dhee`, 'assets', 'images');

      if (!existsSync(imagesDir)) {
        return reply.send({ images: [] });
      }

      try {
        const files = readdirSync(imagesDir)
          .filter(f => ['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(extname(f).toLowerCase()))
          .map(f => ({
            name: f,
            url: `/api/v1/assets/${name}/assets/images/${f}`,
          }));
        return reply.send({ images: files });
      } catch {
        return reply.send({ images: [] });
      }
    }
  );
}
