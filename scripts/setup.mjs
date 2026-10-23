/** Download pinned official engines with real progress and SHA-256 checks. */
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile, rename, stat} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {once} from 'node:events';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(process.env.C4_RUNTIME_DIR || resolve(root, '.runtime'));
const artifacts = [
  {name: 'structurizr.war', version: '2026.09.19', url: 'https://download.structurizr.com/structurizr-2026.09.19.war', sha256: 'ac1a2806e246364b88261a542a36ca7f3006ef48e5de68830afa8672f58690f1'},
  {name: 'plantuml.jar', version: '1.2026.9-mit', url: 'https://repo.maven.apache.org/maven2/net/sourceforge/plantuml/plantuml-mit/1.2026.9/plantuml-mit-1.2026.9.jar', sha256: 'e84e45b37ad3030cf802e7be18a687d209eca55733a5679b1f1f1a515f7f70dd'}
];
await mkdir(target, {recursive: true});
const previous = JSON.parse(await readFile(resolve(target, 'engines.json'), 'utf8').catch(() => '{}'));
const engines = {};
for (const artifact of artifacts) {
  const output = resolve(target, artifact.name);
  if (await stat(output).catch(() => null)) {
    const hash = createHash('sha256').update(await readFile(output)).digest('hex');
    const expected = artifact.sha256 || previous[artifact.name]?.sha256;
    if (!expected || hash !== expected) throw Error(`Integrity check failed: ${output}. Move the file aside and rerun setup.`);
    engines[artifact.name] = {...artifact, sha256: hash};
    console.error(`Verified ${artifact.name}: ${hash}`);
    continue;
  }
  // Measure missing download activity, never total transfer duration.
  const controller = new AbortController();
  const inactivity = Number(process.env.C4_DOWNLOAD_IDLE_MS || 120000);
  let last = Date.now();
  const guard = setInterval(() => {
    if (Date.now() - last > inactivity) controller.abort(Error('Download inactive'));
  }, 5000);
  const temp = output + '.part';
  const stream = createWriteStream(temp);
  try {
    const response = await fetch(artifact.url, {signal: controller.signal});
    if (!response.ok) throw Error(`HTTP ${response.status}: ${artifact.url}`);
    let bytes = 0, reported = 0;
    const hash = createHash('sha256');
    for await (const chunk of response.body) {
      bytes += chunk.length; last = Date.now(); hash.update(chunk);
      if (!stream.write(chunk)) await once(stream, 'drain');
      if (bytes - reported > 8 * 1024 * 1024) {
        console.error(`${artifact.name}: ${(bytes / 1048576).toFixed(1)} MiB received`);
        reported = bytes;
      }
    }
    stream.end(); await once(stream, 'finish');
    const sha256 = hash.digest('hex');
    if (artifact.sha256 && artifact.sha256 !== sha256) throw Error(`Incorrect SHA-256: ${artifact.name}`);
    await rename(temp, output);
    engines[artifact.name] = {...artifact, sha256, bytes};
    console.error(`Downloaded ${artifact.name}: ${bytes} bytes, SHA-256 ${sha256}`);
  } finally { clearInterval(guard); stream.destroy(); }
}
// Pin the initial official HTTPS download hash; this is not a vendor signature.
await writeFile(resolve(target, 'engines.json'), JSON.stringify(engines, null, 2) + '\n');
console.error(`Engines ready in ${target}`);
