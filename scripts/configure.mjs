/** Register C4Loom in one project's Codex configuration, never globally. */
import {mkdir, readFile, writeFile, stat} from 'node:fs/promises';
import {resolve, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--project')) {
  throw Error('Usage: npm run configure -- [--project /absolute/project/path]');
}
const repo = args.length ? resolve(args[1]) : pkg;
if (!(await stat(repo)).isDirectory()) throw Error('The target project must be an existing directory.');
const file = resolve(repo, '.codex/config.toml');
const existing = await readFile(file, 'utf8').catch(error => {if (error.code === 'ENOENT') return ''; throw error;});
const name = 'c4loom';
if (new RegExp(`^\\[mcp_servers\\.${name}(?:\\]|\\.)`, 'm').test(existing)) throw Error(`Entry ${name} already exists in ${file}; left unchanged.`);
const q = value => JSON.stringify(value.replaceAll('\\', '/'));
const lines = [
  '# C4Loom project registration. Does not change global configuration.',
  `[mcp_servers.${name}]`,
  `command = ${q(process.execPath)}`,
  `args = [${q(resolve(pkg, 'src/server.mjs'))}]`,
  `cwd = ${q(pkg)}`,
  'startup_timeout_sec = 30',
  'enabled = true',
  '',
  `[mcp_servers.${name}.env]`,
  `C4_RUNTIME_DIR = ${q(resolve(pkg, '.runtime'))}`,
  `C4_OUTPUT_ROOT = ${q(resolve(repo, '.local/c4loom'))}`,
  'C4_IDLE_MS = "120000"'
];
if (process.env.JAVA_HOME) lines.push(`C4_JAVA = ${q(join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'))}`);
if (process.env.C4_NODE_MODULES) lines.push(`C4_NODE_MODULES = ${q(process.env.C4_NODE_MODULES)}`);
await mkdir(dirname(file), {recursive: true});
await writeFile(file, existing.trimEnd() + (existing.trim() ? '\n\n' : '') + lines.join('\n') + '\n');
console.log(`Project configuration written: ${file}`);
