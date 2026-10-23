/** Verify the actual command and environment resolved by Codex for a project. */
import {readFile, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const saved = await readFile(resolve(root, '.evidence/codex-registration.json'), 'utf8');
if (!saved.trim()) throw Error('Registration evidence is empty. Trust the project in Codex, then save codex mcp get c4loom --json before running this check.');
const settings = JSON.parse(saved);
assert.equal(settings.enabled, true);
assert.equal(settings.transport.type, 'stdio');
const t = settings.transport;
const client = new Client({name: 'c4loom-registration-check', version: '1.0.0'});
const transport = new StdioClientTransport({command: t.command, args: t.args, cwd: t.cwd, env: {...process.env, ...t.env}, stderr: 'pipe'});
transport.stderr?.on('data', data => process.stderr.write(data));
try {
  await client.connect(transport);
  const model = JSON.parse(await readFile(resolve(root, 'examples/self-architecture.json')));
  const result = await client.callTool({name: 'generate_c4', arguments: {project: 'validacion-registro', model}}, undefined, {timeout: 150000, resetTimeoutOnProgress: true, onprogress: () => {}});
  assert.ok(!result.isError, JSON.stringify(result.content));
  assert.equal(result.structuredContent.status, 'completed');
  const manifest = JSON.parse(await readFile(result.structuredContent.manifest));
  assert.equal(manifest.views.length, 4);
  // Missing real engines must produce an error, never simulated diagrams.
  const missing = new Client({name: 'c4loom-missing-engines-check', version: '1.0.0'});
  try {
    await missing.connect(new StdioClientTransport({command: t.command, args: t.args, cwd: t.cwd, env: {...process.env, ...t.env, C4_RUNTIME_DIR: resolve(root, '.evidence/motores-inexistentes')}, stderr: 'pipe'}));
    const failure = await missing.callTool({name: 'check_runtime', arguments: {}});
    assert.equal(failure.isError, true);
  } finally {await missing.close();}
  const evidence = {status: 'passed', configuredCommandTested: true, missingEngineRejected: true, manifest: result.structuredContent.manifest, views: manifest.views, directory: result.structuredContent.directory};
  await writeFile(resolve(root, '.evidence/registro-aceptacion.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally {await client.close();}
