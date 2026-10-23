/** Native Structurizr rendering in Chromium and real PlantUML code rendering. */
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {runJava, runtimeRoot, cpuTime, stopProcess, trackProcess} from './runtime.mjs';
import {createPlantUml} from './model.mjs';

// Optionally reuse a managed package runtime without copying or modifying its packages.
const require = createRequire(process.env.C4_NODE_MODULES ? resolve(process.env.C4_NODE_MODULES, '__c4_loader.cjs') : import.meta.url);
const {chromium} = require('playwright');
const sharp = require('sharp');

export async function renderCode(view, directory, context) {
  await mkdir(directory, {recursive: true});
  const source = resolve(directory, `C4_${view.key}.puml`);
  await writeFile(source, createPlantUml(view));
  await runJava(['-Djava.awt.headless=true', '-DPLANTUML_SECURITY_PROFILE=SECURE', '-jar', resolve(runtimeRoot, 'plantuml.jar'), '-charset', 'UTF-8', '-tsvg', '-failfast2', source], {...context, logFile: source + '.log'});
  const svgPath = source.replace(/\.puml$/, '.svg');
  const svg = await readFile(svgPath, 'utf8');
  if (!svg.includes('<svg') || /Syntax Error|An error has occurred/.test(svg)) throw Error(`PlantUML did not generate view ${view.key}`);
  await saveTransparent(svg, source.replace(/\.puml$/, ''), context);
  // The DSL parser resolves relative files and embeds their content in JSON.
  // This engine version does not accept data URIs as ImageParser paths.
  return `diagrams/C4_${view.key}.svg`;
}

export async function exportStatic(dslPath, directory, context) {
  await runJava(['-jar', resolve(runtimeRoot, 'structurizr.war'), 'export', '-workspace', dslPath, '-format', 'static', '-output', directory], {...context, logFile: resolve(directory, '../structurizr.log')});
  const script = await readFile(resolve(directory, 'workspace.js'), 'utf8');
  const match = script.match(/const jsonAsString = '([^']+)';/);
  if (!match) throw Error('Structurizr export contains no readable workspace');
  const workspace = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
  await writeFile(resolve(directory, '../workspace.json'), JSON.stringify(workspace, null, 2));
  return workspace;
}

export async function renderStructurizr(site, views, directory, context) {
  const owner = await chromium.launchServer({headless: true, executablePath: process.env.C4_CHROMIUM || undefined});
  const untrack = trackProcess(owner.process());
  let browser, page;
  try {
    browser = await chromium.connect(owner.wsEndpoint());
    page = await browser.newPage({viewport: {width: 1600, height: 1000}});
  } catch (error) {
    await stopProcess(owner.process()); untrack(); throw error;
  }
  const errors = [];
  const started = Date.now();
  let lastActivity = started, cpu = -1, sampling = false, failed = false;
  let rejectIdle;
  const idleFailure = new Promise((_, reject) => {rejectIdle = reject;});
  const touch = () => {lastActivity = Date.now();};
  page.on('requestfinished', touch); page.on('console', touch);
  page.on('pageerror', error => errors.push(error.message));
  const cancel = () => {failed = true; rejectIdle(Error('Rendering cancelled by the client')); void stopProcess(owner.process());};
  context.signal?.addEventListener('abort', cancel, {once: true});
  const idleMs = Number(process.env.C4_IDLE_MS || 120000);
  const guard = setInterval(async () => {
    if (sampling || failed) return;
    sampling = true;
    try {
      // Chromium is multi-process: sample CPU for its complete managed process tree.
      const next = await cpuTime(owner.process().pid, true).catch(() => cpu);
      if (next !== cpu) {touch(); cpu = next;}
      context.progress({phase: 'browser_rendering', elapsedMs: Date.now() - started, idleMs: Date.now() - lastActivity, cpu});
      if (Date.now() - lastActivity > idleMs) {
        failed = true; rejectIdle(Error(`Browser inactive for ${idleMs} ms`));
        await stopProcess(owner.process());
      }
    } finally {sampling = false;}
  }, 5000);
  const wait = promise => Promise.race([promise, idleFailure]);
  // Model and assets are local; rendering does not request external services.
  await page.route(/^https?:\/\//, route => route.abort());
  try {
    await page.goto(pathToFileURL(resolve(site, 'index.html')).href, {waitUntil: 'load', timeout: 30000});
    await wait(page.waitForFunction(() => globalThis.structurizr?.scripting?.isDiagramRendered(), undefined, {timeout: 0}));
    for (const view of views.filter(v => v.level < 4)) {
      context.signal?.throwIfAborted();
      context.progress({phase: `render_${view.key}`, completedView: view.key});
      // Use the official browser export API rather than a screenshot.
      const svg = await wait(page.evaluate(key => new Promise((accept, reject) => {
        try {
          structurizr.diagram.changeView(key, () => structurizr.diagram.exportCurrentDiagramToSVG({metadata: true, crop: true, dimensions: true}, accept));
        } catch (error) {reject(error);}
      }), view.key));
      if (typeof svg !== 'string' || !svg.includes('<svg')) throw Error(`SVG unavailable: ${view.key}`);
      await saveTransparent(svg, resolve(directory, view.key), context);
    }
    if (errors.length) throw Error(`Browser errors: ${errors.join('; ')}`);
    return {browser: browser.version(), errors};
  } catch (error) {
    await page.screenshot({path: resolve(directory, '../render-failure.png')}).catch(() => {});
    throw error;
  } finally {
    clearInterval(guard); context.signal?.removeEventListener('abort', cancel);
    await browser.close().catch(() => {});
    await owner.close().catch(() => stopProcess(owner.process()));
    untrack();
  }
}

export async function saveTransparent(svg, base, context = {}) {
  // Remove only the root canvas background, preserving element colors.
  const clean = svg.replace(/<svg\b[^>]*>/, tag => tag.replace(/background(?:-color)?\s*:\s*[^;"']+;?/gi, ''));
  const png = base + '.png';
  await writeFile(base + '.svg', clean);
  await sharp(Buffer.from(clean), {density: 144, limitInputPixels: 100_000_000}).png().toFile(png);
  const {data, info} = await sharp(png).ensureAlpha().raw().toBuffer({resolveWithObject: true});
  const alpha = index => data[index * info.channels + info.channels - 1];
  const corners = [0, info.width - 1, (info.height - 1) * info.width, info.width * info.height - 1].map(alpha);
  let visible = 0;
  for (let i = info.channels - 1; i < data.length; i += info.channels) if (data[i]) visible++;
  if (!visible || !corners.every(a => a === 0)) throw Error(`Empty image or non-transparent canvas: ${base}`);
  const receipt = {width: info.width, height: info.height, alpha: true, cornerAlpha: corners, visiblePixels: visible};
  await writeFile(base + '.image.json', JSON.stringify(receipt, null, 2));
  context.progress?.({phase: 'image_verified', artifact: png, ...receipt});
  return receipt;
}
