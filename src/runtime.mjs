/** Supervise real inactivity and clean up only processes owned by this MCP. */
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile, writeFile, realpath, mkdir, stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve, dirname, relative, isAbsolute, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const runtimeRoot = resolve(process.env.C4_RUNTIME_DIR || resolve(packageRoot, '.runtime'));
export const outputRoot = resolve(process.env.C4_OUTPUT_ROOT || resolve(packageRoot, 'output'));
const exec = promisify(execFile);
const children = new Set();
export function trackProcess(child) {children.add(child); return () => children.delete(child);}

export async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') await exec('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true}).catch(() => {});
  else { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
}
export async function cleanupChildren() { await Promise.all([...children].map(stopProcess)); }

export async function cpuTime(pid, tree = false) {
  if (process.platform === 'win32') {
    const command = tree
      ? `$all=Get-CimInstance Win32_Process; $ids=[Collections.Generic.HashSet[int]]::new(); [void]$ids.Add(${Number(pid)}); do {$n=$ids.Count; foreach($p in $all){if($ids.Contains([int]$p.ParentProcessId)){[void]$ids.Add([int]$p.ProcessId)}}} while($ids.Count -ne $n); $sum=0.0; foreach($p in $all){if($ids.Contains([int]$p.ProcessId)){$sum += [double]$p.UserModeTime + [double]$p.KernelModeTime}}; [Console]::Write($sum)`
      : `(Get-Process -Id ${Number(pid)} -ErrorAction Stop).TotalProcessorTime.TotalMilliseconds`;
    const {stdout} = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {windowsHide: true, timeout: 5000});
    return Number(stdout.trim());
  }
  const data = (await readFile(`/proc/${pid}/stat`, 'utf8')).split(') ')[1].split(' ');
  let total = Number(data[11]) + Number(data[12]);
  if (tree) {
    const descendants = await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8').catch(() => '');
    for (const child of descendants.trim().split(/\s+/).filter(Boolean)) total += await cpuTime(Number(child), true).catch(() => 0);
  }
  return total;
}

export async function runJava(args, {logFile, signal, progress = () => {}} = {}) {
  signal?.throwIfAborted();
  const java = process.env.C4_JAVA || 'java';
  const started = Date.now();
  let activity = started, cpu = -1, output = '', sampling = false;
  const child = spawn(java, args, {windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']});
  children.add(child);
  const chunks = [];
  const consume = data => {activity = Date.now(); chunks.push(data); output = (output + data.toString()).slice(-32768);};
  child.stdout.on('data', consume); child.stderr.on('data', consume);
  const idleMs = Number(process.env.C4_IDLE_MS || 120000);
  let failure;
  const cancel = () => {failure = Error('Operation cancelled by the client'); void stopProcess(child);};
  signal?.addEventListener('abort', cancel, {once: true});
  const timer = setInterval(async () => {
    if (sampling) return;
    sampling = true;
    try {
      const next = await cpuTime(child.pid).catch(() => cpu);
      if (next !== cpu) {activity = Date.now(); cpu = next;}
      progress({phase: 'java_engine', elapsedMs: Date.now() - started, idleMs: Date.now() - activity, pid: child.pid});
      if (Date.now() - activity > idleMs) {failure = Error(`Engine inactive for ${idleMs} ms`); await stopProcess(child);}
    } finally {sampling = false;}
  }, 5000);
  try {
    await new Promise((accept, reject) => {
      child.once('error', reject);
      child.once('close', code => code === 0 && !failure ? accept() : reject(failure || Error(`Java exited with code ${code}: ${output.replace(/data:image[^\s"]+/g, '[embedded image]').slice(0, 1800)}. Log: ${logFile || 'stderr'}`)));
    });
    return output;
  } finally {
    clearInterval(timer); children.delete(child); signal?.removeEventListener('abort', cancel);
    if (logFile) await writeFile(logFile, Buffer.concat(chunks));
  }
}

export async function verifyEngines() {
  const manifest = JSON.parse(await readFile(resolve(runtimeRoot, 'engines.json'), 'utf8').catch(() => {throw Error('Engines missing. Run npm run setup in the package directory.');}));
  for (const name of ['structurizr.war', 'plantuml.jar']) {
    const actual = createHash('sha256').update(await readFile(resolve(runtimeRoot, name))).digest('hex');
    if (actual !== manifest[name]?.sha256) throw Error(`Modified or incomplete engine: ${name}`);
  }
  return manifest;
}

export async function safeOutput(path) {
  await mkdir(outputRoot, {recursive: true});
  const root = await realpath(outputRoot);
  const candidate = resolve(root, path);
  const rel = relative(root, candidate);
  if (!rel || rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel)) throw Error('Path outside the output directory');
  // Resolve links and junctions in existing ancestors before creating anything.
  let ancestor = candidate;
  while (!(await stat(ancestor).catch(() => null))) ancestor = dirname(ancestor);
  const real = await realpath(ancestor);
  const actualRel = relative(root, real);
  if (actualRel === '..' || actualRel.startsWith('..' + sep) || isAbsolute(actualRel)) throw Error('Link outside the output directory');
  return candidate;
}

export function classifyError(error) {
  const message = String(error?.message || error);
  const category = /cancelled|inactive/i.test(message) ? 'cancellation_or_inactivity'
    : /ParserException|Syntax Error|identifier|relationship|C[234] requires|component outside|code member/i.test(message) ? 'invalid_model'
    : /official MCP|HTTP|fetch|ECONN|ETIMEDOUT/i.test(message) ? 'mcp_validation_or_connection'
    : /path outside|output directory|link outside/i.test(message) ? 'disallowed_path'
    : /missing|ENOENT|engine|browser|executable|SHA-256|integrity|UnsupportedClassVersion|Java exited/i.test(message) ? 'dependency_or_engine'
    : 'input_or_rendering';
  return {category, message};
}
