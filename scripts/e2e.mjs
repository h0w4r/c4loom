/** Real stdio MCP client: generation, read-back and failure/recovery. */
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const client = new Client({name: 'c4loom-e2e', version: '1.0.0'});
const transport = new StdioClientTransport({command: process.execPath, args: [resolve(root, 'src/server.mjs')], env: {...process.env, C4_OUTPUT_ROOT: resolve(root, '.evidence/output')}, stderr: 'pipe'});
let logs = '';
transport.stderr?.on('data', data => {logs += data; process.stderr.write(data);});
await mkdir(resolve(root, '.evidence'), {recursive: true});
try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.ok(tools.tools.some(t => t.name === 'generate_c4'));
  const model = JSON.parse(await readFile(resolve(root, 'examples/self-architecture.json')));
  const invoke = (name, args) => client.callTool({name, arguments: args}, undefined, {
    // SDK progress renews the wait; no total operation deadline is imposed.
    timeout: 150000, resetTimeoutOnProgress: true,
    onprogress: p => process.stderr.write(`[MCP] ${p.message}\n`)
  });
  const invalid = structuredClone(model); invalid.relationships[0].target = 'ausente';
  const rejected = await invoke('generate_c4', {project: 'modelo-invalido', model: invalid});
  assert.equal(rejected.isError, true);
  const parserFailure = await invoke('render_structurizr', {project: 'error-parser-real', dsl: 'workspace {\n model {\n noExiste = elementoDesconocido "Entrada"\n }\n}'});
  assert.equal(parserFailure.isError, true);
  // The same process recovers and renders all levels with real engines.
  const response = await invoke('generate_c4', {project: 'generador-c4', model});
  if (response.isError) throw Error(JSON.stringify(response.content));
  const manifest = response.structuredContent;
  assert.equal(manifest.status, 'completed');
  assert.deepEqual([...new Set(manifest.views.map(v => v.level))].sort(), [1, 2, 3, 4]);
  for (const artifact of manifest.artifacts) {
    const bytes = await readFile(artifact.path);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256);
  }
  const pngs = manifest.artifacts.filter(a => a.path.endsWith('.png'));
  assert.equal(pngs.length, manifest.views.length);
  const readBack = await invoke('read_artifact', {path: pngs[0].path});
  assert.equal(readBack.content[0].type, 'image');
  assert.ok(Buffer.from(readBack.content[0].data, 'base64').equals(await readFile(pngs[0].path)));
  const outside = await invoke('read_artifact', {path: resolve(root, 'package.json')});
  assert.equal(outside.isError, true);
  const readManifest = await invoke('read_artifact', {path: manifest.manifest});
  assert.equal(JSON.parse(readManifest.content[0].text).runId, manifest.runId);
  // Navigate the native viewer, including the C4 image linked to its component.
  const require = createRequire(process.env.C4_NODE_MODULES ? resolve(process.env.C4_NODE_MODULES, '__c4_loader.cjs') : import.meta.url);
  const {chromium} = require('playwright');
  const browser = await chromium.launch({headless: true, executablePath: process.env.C4_CHROMIUM || undefined});
  const visited = [];
  try {
    const page = await browser.newPage({viewport: {width: 1600, height: 1000}});
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    for (const view of manifest.views) {
      await page.goto(pathToFileURL(manifest.viewer).href + '#' + view.key);
      await page.waitForFunction(key => globalThis.structurizr?.scripting?.isDiagramRendered() && structurizr.scripting.getViewKey() === key, view.key);
      const geometry = await page.locator('#diagram').boundingBox();
      assert.ok(geometry.width > 0 && geometry.height > 0);
      await page.screenshot({path: resolve(root, '.evidence', `viewer-${view.key}.png`)});
      visited.push(view.key);
    }
    assert.deepEqual(errors, []);
  } finally {await browser.close();}
  await writeFile(resolve(root, '.evidence/latest.json'), JSON.stringify({status: 'passed', tools: tools.tools.map(t => t.name), invalidInputRejected: true, nativeParserFailureVerified: true, recoveredInSameSession: true, outsideReadRejected: true, pngReadBackVerified: true, visited, manifest}, null, 2));
  console.log(JSON.stringify({status: 'passed', runId: manifest.runId, manifest: manifest.manifest, pngs: pngs.map(a => a.path)}, null, 2));
} finally {
  await client.close();
  await writeFile(resolve(root, '.evidence/mcp-stderr.log'), logs);
}
