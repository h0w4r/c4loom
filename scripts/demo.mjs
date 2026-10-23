/** Generate a real four-level example through the public stdio MCP transport. */
import {readFile} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const model = JSON.parse(await readFile(resolve(root, 'examples/self-architecture.json'), 'utf8'));
const client = new Client({name: 'c4loom-demo', version: '1.0.0'});
const transport = new StdioClientTransport({
  command: process.execPath, args: [resolve(root, 'src/server.mjs')],
  env: {...process.env}, stderr: 'inherit'
});
try {
  await client.connect(transport);
  const result = await client.callTool({name: 'generate_c4', arguments: {project: 'c4loom-demo', model}}, undefined, {
    // Each real progress event renews the wait; this is not a total-duration limit.
    timeout: 150000, resetTimeoutOnProgress: true,
    onprogress: progress => console.error(`[C4Loom] ${progress.message}`)
  });
  if (result.isError) throw Error(JSON.stringify(result.content));
  const {manifest, viewer, directory, views} = result.structuredContent;
  console.log(JSON.stringify({directory, manifest, viewer, views}, null, 2));
} finally {await client.close();}
