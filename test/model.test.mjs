/** Contract tests do not replace real MCP and rendering acceptance tests. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {validateModel, createDsl, createPlantUml, assertSelfContainedDsl} from '../src/model.mjs';
const sample = JSON.parse(await readFile(new URL('../examples/self-architecture.json', import.meta.url)));
const clone = () => structuredClone(sample);

test('complete contract preserves the system and views', () => {
  const m = validateModel(clone());
  const {dsl, views} = createDsl(m, [1, 2, 3, 4], {compilador: 'data:image/svg+xml;base64,PHN2Zy8+'});
  assert.equal(views.length, 4);
  assert.match(dsl, /systemContext generador/);
  assert.match(dsl, /image contrato "C4_compilador"/);
});
test('rejects duplicate identifiers across levels', () => {
  const m = clone(); m.people[0].id = 'mcp';
  assert.throws(() => validateModel(m), /Duplicate/);
});
test('rejects missing relationship endpoints', () => {
  const m = clone(); m.relationships[0].target = 'inexistente';
  assert.throws(() => validateModel(m), /missing endpoint/);
});
test('does not invent missing code-level detail', () => {
  const m = clone(); m.codeViews = [];
  assert.throws(() => validateModel(m), /C4 requires/);
  assert.doesNotThrow(() => validateModel(m, [1, 2, 3]));
});
test('rejects code views attached to containers', () => {
  const m = clone(); m.codeViews[0].component = 'mcp';
  assert.throws(() => validateModel(m), /component/);
});
test('escapes quotes without injecting DSL lines', () => {
  const m = clone(); m.title = 'Modelo "citado"';
  assert.match(createDsl(validateModel(m), [1]).dsl, /Modelo \\"citado\\"/);
});
test('code views distinguish modules from classes', () => {
  const puml = createPlantUml(validateModel(clone()).codeViews[0]);
  assert.match(puml, /<<module>>/); assert.match(puml, /backgroundColor transparent/);
});
test('blocks injected directives in code members', () => {
  const m = clone(); m.codeViews[0].elements[0].operations.push('x\n!include archivo');
  assert.throws(() => validateModel(m));
});
test('imported DSL rejects scripts, includes and external references', () => {
  for (const dsl of ['!include ../../secreto', 'workspace {\n !script javascript {\n}', 'workspace {\n image * {\n image https://ejemplo.test\n}\n}', 'workspace extends "../../archivo.dsl" {\n}', 'workspace {\n views {\n theme "../../tema.json"\n}\n}']) assert.throws(() => assertSelfContainedDsl(dsl));
});
test('rejects code relationships outside their view', () => {
  const m = clone(); m.codeViews[0].relationships[0].target = 'otro';
  assert.throws(() => validateModel(m), /incomplete/);
});
