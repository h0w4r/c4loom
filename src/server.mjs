#!/usr/bin/env node
/** Stdio MCP server for C1-C4 generation, rendering and local artifact inspection. */
import {z} from 'zod';
import {pathToFileURL} from 'node:url';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {modelSchema} from './model.mjs';
import {generate, renderExisting, readArtifact} from './pipeline.mjs';
import {verifyEngines, classifyError, cleanupChildren, outputRoot} from './runtime.mjs';

const server = new McpServer({name: 'c4loom', version: '1.0.0'}, {
  instructions: 'Generate real C4 images from an explicit model. Do not infer unsupported facts. Declare codeViews when requesting all four levels. Outputs include transparent SVG/PNG and editable sources. The official MCP is an optional validation complement, never a simulated dependency.'
});
const project = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/).describe('Output project folder name');

function context(extra) {
  let count = 0;
  return {signal: extra.signal, progress: event => {
    // Keep stdout exclusively for JSON-RPC; send diagnostics to stderr.
    console.error(JSON.stringify({event: 'c4_progress', ...event}));
    const token = extra._meta?.progressToken;
    if (token !== undefined) void extra.sendNotification({method: 'notifications/progress', params: {progressToken: token, progress: ++count, message: event.phase}}).catch(() => {});
  }};
}
function result(output) {
  // Full events remain in the manifest rather than flooding the agent context.
  const {events, engines, ...summary} = output;
  const links = output.artifacts.filter(a => /\.(png|svg|dsl|puml)$/.test(a.path)).map(a => ({
    type: 'resource_link', uri: pathToFileURL(a.path).href, name: a.relativePath,
    mimeType: a.path.endsWith('.png') ? 'image/png' : a.path.endsWith('.svg') ? 'image/svg+xml' : 'text/plain'
  }));
  return {content: [{type: 'text', text: JSON.stringify(summary, null, 2)}, ...links], structuredContent: summary};
}
const guarded = handler => async (args, extra) => {
  try {return await handler(args, extra);} catch (error) {
    return {isError: true, content: [{type: 'text', text: JSON.stringify(classifyError(error))}]};
  }
};

server.registerTool('generate_c4', {
  title: 'Generar diagrams C4',
  description: 'Generate Structurizr DSL/JSON and real C1 context, C2 container, C3 component and C4 code diagrams from an explicit architecture model. Returns transparent SVG/PNG, a viewer and a hashed manifest.',
  inputSchema: {project, model: modelSchema, levels: z.array(z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])).min(1).max(4).default([1, 2, 3, 4])},
  annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false}
}, guarded(async (args, extra) => result(await generate(args, context(extra)))));

server.registerTool('render_structurizr', {
  title: 'Render Structurizr DSL',
  description: 'Render real C1-C3 images from self-contained DSL. Use generate_c4 with codeViews for C4. Rejects executable directives and external references.',
  inputSchema: {project, dsl: z.string().min(1).max(2_000_000)},
  annotations: {readOnlyHint: false, destructiveHint: false, openWorldHint: false}
}, guarded(async (args, extra) => result(await renderExisting(args, context(extra)))));

server.registerTool('read_artifact', {
  title: 'Read a generated artifact', description: 'Return PNG images, editable sources or manifests, restricted to the output root.',
  inputSchema: {path: z.string().min(1)}, annotations: {readOnlyHint: true, openWorldHint: false}
}, guarded(async ({path}) => ({content: [await readArtifact(path)]})));

server.registerTool('check_runtime', {
  title: 'Check local engines', description: 'Verify Structurizr and PlantUML hashes. This check does not replace a real generation.',
  inputSchema: {}, annotations: {readOnlyHint: true, openWorldHint: false}
}, guarded(async () => ({content: [{type: 'text', text: JSON.stringify({engines: await verifyEngines(), outputRoot, officialMcpConfigured: Boolean(process.env.C4_OFFICIAL_MCP_URL)})}]})));

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {await cleanupChildren(); await server.close(); process.exit(0);});
process.stdin.on('end', () => {void cleanupChildren();});
await server.connect(new StdioServerTransport());
