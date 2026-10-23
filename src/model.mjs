/** Architecture contract: never infer undeclared components or relationships. */
import {z} from 'zod';

export const identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
const label = z.string().min(1).max(500).refine(s => !/[\x00-\x08\x0b-\x1f]/.test(s), 'Text contains control characters');
const element = {id: identifier, name: label, description: label, technology: label.optional()};
const component = z.object(element).strict();
const container = z.object({...element, components: z.array(component).max(100).default([])}).strict();
const system = z.object({...element, containers: z.array(container).max(50).default([])}).strict();
const relationship = z.object({source: identifier, target: identifier, description: label, technology: label.optional()}).strict();
// Members are data lines, never executable PlantUML directives.
const member = z.string().min(1).max(300).refine(s => !/[\r\n@!{}\x00-\x1f]/.test(s), 'Invalid code member');
const codeElement = z.object({
  id: identifier, name: label,
  kind: z.enum(['class', 'interface', 'module', 'procedure', 'record']).default('class'),
  attributes: z.array(member).max(60).default([]), operations: z.array(member).max(60).default([])
}).strict();
const codeRelation = z.object({
  source: identifier, target: identifier, description: label,
  kind: z.enum(['dependency', 'association', 'composition', 'inheritance']).default('dependency')
}).strict();
export const codeViewSchema = z.object({
  key: identifier, component: identifier, title: label,
  elements: z.array(codeElement).min(1).max(100),
  relationships: z.array(codeRelation).max(500).default([])
}).strict();
export const modelSchema = z.object({
  title: label, description: label, focalSystem: identifier,
  people: z.array(z.object({id: identifier, name: label, description: label}).strict()).max(100).default([]),
  systems: z.array(system).min(1).max(50),
  relationships: z.array(relationship).max(1500).default([]),
  codeViews: z.array(codeViewSchema).max(50).default([])
}).strict();

export function validateModel(input, levels = [1, 2, 3, 4]) {
  const model = modelSchema.parse(input);
  const ids = new Map();
  const add = (node, kind, parent) => {
    if (ids.has(node.id)) throw Error(`Duplicate identifier: ${node.id}`);
    ids.set(node.id, {node, kind, parent});
  };
  model.people.forEach(p => add(p, 'person'));
  for (const s of model.systems) {
    add(s, 'system');
    for (const c of s.containers) { add(c, 'container', s.id); c.components.forEach(p => add(p, 'component', c.id)); }
  }
  if (ids.size > 600) throw Error('Model exceeds 600 elements');
  const focal = ids.get(model.focalSystem);
  if (focal?.kind !== 'system') throw Error('focalSystem must identify a declared system');
  for (const r of model.relationships) {
    if (!ids.has(r.source) || !ids.has(r.target)) throw Error(`Relationship has a missing endpoint: ${r.source} -> ${r.target}`);
    if (r.source === r.target) throw Error(`Self-relationships are not supported: ${r.source}`);
  }
  if (levels.includes(2) && !focal.node.containers.length) throw Error('C2 requires declared containers');
  if (levels.includes(3) && !focal.node.containers.some(c => c.components.length)) throw Error('C3 requires declared components');
  if (levels.includes(4) && !model.codeViews.length) throw Error('C4 requires at least one code view with explicitly declared elements');
  const keys = new Set();
  for (const v of model.codeViews) {
    if (keys.has(v.key)) throw Error(`Duplicate code view: ${v.key}`);
    keys.add(v.key);
    const owner = ids.get(v.component);
    if (owner?.kind !== 'component' || ids.get(owner.parent)?.parent !== model.focalSystem) throw Error(`View ${v.key}: component outside the focal system`);
    const local = new Set();
    for (const e of v.elements) {
      if (local.has(e.id)) throw Error(`Duplicate code element: ${e.id}`);
      local.add(e.id);
    }
    for (const r of v.relationships) if (!local.has(r.source) || !local.has(r.target)) throw Error(`View ${v.key}: incomplete code relationship`);
  }
  return model;
}

const q = value => JSON.stringify(value ?? '');
export function createDsl(model, levels, codeImages = {}) {
  const lines = [`// C4 model generated from an explicit architecture contract.`, `workspace ${q(model.title)} ${q(model.description)} {`, '    model {'];
  for (const p of model.people) lines.push(`        ${p.id} = person ${q(p.name)} ${q(p.description)}`);
  for (const s of model.systems) {
    lines.push(`        ${s.id} = softwareSystem ${q(s.name)} ${q(s.description)} {`);
    for (const c of s.containers) {
      lines.push(`            ${c.id} = container ${q(c.name)} ${q(c.description)} ${q(c.technology)} {`);
      for (const p of c.components) lines.push(`                ${p.id} = component ${q(p.name)} ${q(p.description)} ${q(p.technology)}`);
      lines.push('            }');
    }
    lines.push('        }');
  }
  for (const r of model.relationships) lines.push(`        ${r.source} -> ${r.target} ${q(r.description)} ${q(r.technology)}`);
  lines.push('    }', '    views {');
  const focal = model.systems.find(s => s.id === model.focalSystem);
  const views = [];
  const view = (type, owner, key, title, level) => {
    lines.push(`        ${type} ${owner} ${q(key)} {`, `            title ${q(title)}`, '            include *', '            autoLayout lr', '        }');
    views.push({key, title, level});
  };
  if (levels.includes(1)) view('systemContext', focal.id, 'C1_context', `C1 System context: ${focal.name}`, 1);
  if (levels.includes(2)) view('container', focal.id, 'C2_containers', `C2 Containers: ${focal.name}`, 2);
  if (levels.includes(3)) for (const c of focal.containers.filter(c => c.components.length)) view('component', c.id, `C3_${c.id}`, `C3 Components: ${c.name}`, 3);
  if (levels.includes(4)) for (const v of model.codeViews) {
    if (!codeImages[v.key]) continue;
    // Embed the local C4 image as a Structurizr view associated with its component.
    lines.push(`        image ${v.component} ${q(`C4_${v.key}`)} {`, `            title ${q(v.title)}`, `            image ${q(codeImages[v.key])}`, '        }');
    views.push({key: `C4_${v.key}`, title: v.title, level: 4});
  }
  lines.push('        terminology {', '            person "Person"', '            softwareSystem "Software System"', '            container "Container"', '            component "Component"', '            relationship "Relationship"', '        }');
  lines.push('        styles {', '            element "Element" {', '                color #FFFFFF', '                background #234E70', '                fontSize 24', '            }', '            element "Person" {', '                shape Person', '                background #175B47', '            }', '        }', '    }', '}');
  return {dsl: lines.join('\n') + '\n', views};
}

export function createPlantUml(view) {
  const lines = ['@startuml', "' Code detail linked to a C4 component.", '!pragma layout smetana', 'skinparam backgroundColor transparent', 'skinparam shadowing false', 'skinparam classAttributeIconSize 0', 'skinparam defaultFontName Arial', 'skinparam defaultFontSize 16', 'hide empty members', `title ${view.title.replace(/[\r\n]/g, ' ')}`];
  for (const e of view.elements) {
    const type = e.kind === 'interface' ? 'interface' : 'class';
    const stereotype = ['class', 'interface'].includes(e.kind) ? '' : ` <<${e.kind}>>`;
    lines.push(`${type} ${q(e.name)} as ${e.id}${stereotype} {`);
    lines.push(...e.attributes.map(a => `  ${a}`), ...e.operations.map(o => `  ${o}`), '}');
  }
  const arrows = {dependency: '..>', association: '-->', composition: '*--', inheritance: '--|>'};
  for (const r of view.relationships) lines.push(`${r.source} ${arrows[r.kind]} ${r.target} : ${r.description.replace(/[\r\n]/g, ' ')}`);
  lines.push('@enduml');
  return lines.join('\n') + '\n';
}

export function assertSelfContainedDsl(dsl) {
  // The import operation rejects executable directives, files and external URLs.
  if (dsl.length > 2_000_000 || /^\s*!/m.test(dsl) || /\bhttps?:\/\//i.test(dsl) || /^\s*(image|icon|url|theme|themes)\s/m.test(dsl) || /\bworkspace\s+extends\b/.test(dsl)) throw Error('Imported DSL must be self-contained, without directives, images or external resources');
}
