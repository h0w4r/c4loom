/** Real pipeline: contract -> DSL -> engines -> images -> durable manifest. */
import {readFile, writeFile, mkdir, readdir} from 'node:fs/promises';
import {resolve, relative} from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {validateModel, createDsl, assertSelfContainedDsl} from './model.mjs';
import {verifyEngines, safeOutput, classifyError, outputRoot} from './runtime.mjs';
import {renderCode, exportStatic, renderStructurizr} from './render.mjs';

const writeJson = (file, data) => writeFile(file, JSON.stringify(data, null, 2) + '\n');

export async function officialValidate(dsl) {
  const endpoint = process.env.C4_OFFICIAL_MCP_URL;
  if (!endpoint) return {status: 'not_configured', localValidation: 'local_structurizr_engine'};
  const url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol)) throw Error('Official MCP protocol is not allowed');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!local && process.env.C4_ALLOW_REMOTE_OFFICIAL !== '1') throw Error('Remote official MCP is disabled; set C4_ALLOW_REMOTE_OFFICIAL=1');
  const client = new Client({name: 'c4loom', version: '1.0.0'});
  try {
    const timeout = Number(process.env.C4_CONNECT_MS || 20000);
    await client.connect(new StreamableHTTPClientTransport(url), {timeout});
    const result = await client.callTool({name: 'validate', arguments: {dsl}}, undefined, {timeout, resetTimeoutOnProgress: true});
    const text = result.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') || '';
    if (result.isError || !/^"?OK"?$/.test(text.trim())) throw Error(`Official MCP validation rejected: ${text}`);
    return {status: 'validated', endpoint: url.origin, response: text};
  } finally {await client.close();}
}

export async function listArtifacts(directory, root = directory) {
  const output = [];
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const file = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      // Keep viewer assets without inflating the deliverable manifest.
      if (entry.name !== 'viewer') output.push(...await listArtifacts(file, root));
    } else if (/\.(dsl|json|png|svg|puml)$/.test(entry.name) && !['manifest.json', 'error.json'].includes(entry.name)) {
      const bytes = await readFile(file);
      output.push({path: file, relativePath: relative(root, file).replaceAll('\\', '/'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')});
    }
  }
  return output;
}

export async function generate({project, model: input, levels = [1, 2, 3, 4]}, context = {}) {
  const model = validateModel(input, levels);
  const runId = randomUUID();
  const directory = await safeOutput(`${project}/${runId}`);
  await mkdir(directory, {recursive: true});
  const events = [];
  const start = Date.now();
  const progress = event => {events.push({elapsedMs: Date.now() - start, ...event}); context.progress?.(event);};
  const run = {signal: context.signal, progress};
  try {
    const engines = await verifyEngines();
    progress({phase: 'contract_validated', runId});
    await writeJson(resolve(directory, 'architecture.json'), model);
    const images = {};
    const diagrams = resolve(directory, 'diagrams');
    await mkdir(diagrams);
    if (levels.includes(4)) for (const view of model.codeViews) {
      progress({phase: `code_${view.key}`});
      images[view.key] = await renderCode(view, diagrams, run);
    }
    const {dsl, views} = createDsl(model, levels, images);
    await writeFile(resolve(directory, 'workspace.dsl'), dsl);
    // The official MCP disables file access: send only the structural model
    // without local C4 images; this does not validate UML code detail.
    const coreDsl = createDsl(model, levels.filter(level => level < 4)).dsl;
    const officialValidation = {...await officialValidate(coreDsl), scope: 'structural_model_without_C4_images'};
    progress({phase: 'official_validation', status: officialValidation.status});
    // The real export requires the official parser to accept the complete model.
    const workspace = await exportStatic(resolve(directory, 'workspace.dsl'), resolve(directory, 'viewer'), run);
    const actualViews = Object.values(workspace.views).filter(Array.isArray).flat().map(v => v.key);
    for (const view of views) if (!actualViews.includes(view.key)) throw Error(`Structurizr did not preserve view ${view.key}`);
    const rendering = await renderStructurizr(resolve(directory, 'viewer'), views, diagrams, run);
    for (const view of views) {
      for (const ext of ['svg', 'png', 'image.json']) await readFile(resolve(diagrams, `${view.key}.${ext}`));
    }
    const artifacts = await listArtifacts(directory);
    const manifest = {status: 'completed', runId, project, requestedLevels: levels, views, engines, officialValidation, rendering, elapsedMs: Date.now() - start, artifacts, events};
    await writeJson(resolve(directory, 'manifest.json'), manifest);
    progress({phase: 'completed', views: views.length});
    return {...manifest, directory, manifest: resolve(directory, 'manifest.json'), viewer: resolve(directory, 'viewer/index.html')};
  } catch (error) {
    const diagnosis = {status: 'failed', runId, project, ...classifyError(error), elapsedMs: Date.now() - start, events};
    await writeJson(resolve(directory, 'error.json'), diagnosis);
    throw Error(`${diagnosis.message}\nDiagnosis: ${resolve(directory, 'error.json')}`);
  }
}

export async function renderExisting({project, dsl}, context = {}) {
  assertSelfContainedDsl(dsl);
  const directory = await safeOutput(`${project}/${randomUUID()}`);
  await mkdir(directory, {recursive: true});
  try {
    await verifyEngines();
    await writeFile(resolve(directory, 'workspace.dsl'), dsl);
    const officialValidation = await officialValidate(dsl);
    const workspace = await exportStatic(resolve(directory, 'workspace.dsl'), resolve(directory, 'viewer'), context);
    const kinds = [['systemContextViews', 1], ['containerViews', 2], ['componentViews', 3]];
    const views = kinds.flatMap(([key, level]) => (workspace.views[key] || []).map(v => ({key: v.key, level, title: v.description || v.key})));
    if (!views.length) throw Error('DSL has no C1, C2 or C3 views');
    await mkdir(resolve(directory, 'diagrams'));
    const rendering = await renderStructurizr(resolve(directory, 'viewer'), views, resolve(directory, 'diagrams'), {progress: () => {}, ...context});
    const manifest = {status: 'completed', directory, views, officialValidation, rendering, artifacts: await listArtifacts(directory)};
    await writeJson(resolve(directory, 'manifest.json'), manifest);
    return {...manifest, manifest: resolve(directory, 'manifest.json'), viewer: resolve(directory, 'viewer/index.html')};
  } catch (error) {
    await writeJson(resolve(directory, 'error.json'), {status: 'failed', ...classifyError(error)});
    throw error;
  }
}

export async function readArtifact(path) {
  const file = await safeOutput(relative(outputRoot, resolve(path)));
  const bytes = await readFile(file);
  if (bytes.length > 8 * 1024 * 1024) throw Error('Artifact exceeds 8 MiB; open the local file');
  if (file.endsWith('.png')) return {type: 'image', mimeType: 'image/png', data: bytes.toString('base64')};
  if (/\.(dsl|json|svg|puml|log)$/.test(file)) return {type: 'text', text: bytes.toString('utf8')};
  throw Error('Unsupported artifact format');
}
