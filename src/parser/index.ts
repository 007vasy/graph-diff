import Parser from 'web-tree-sitter';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import type { FnNode } from '../types.js';
import { langForPath, type LangSpec } from './languages.js';

export { langForPath, LANGS } from './languages.js';

const require = createRequire(import.meta.url);
let initPromise: Promise<void> | undefined;

interface Handlers {
  type: string;
  fn?: (n: Parser.SyntaxNode) => string | null;
  con?: (n: Parser.SyntaxNode) => string | null;
  call?: (n: Parser.SyntaxNode) => { name: string; recv?: string }[];
  imp?: (n: Parser.SyntaxNode) => string[];
}
interface Loaded {
  parser: Parser;
  /** typeId → handlers; numeric dispatch avoids marshalling a type string out of WASM per node */
  table: Array<Handlers | undefined>;
}
const languages = new Map<string, Promise<Loaded>>();

function init() {
  initPromise ??= Parser.init();
  return initPromise;
}

async function parserFor(spec: LangSpec): Promise<Loaded> {
  let p = languages.get(spec.id);
  if (!p) {
    p = (async () => {
      await init();
      const lang = await Parser.Language.load(require.resolve(spec.wasm));
      const parser = new Parser();
      parser.setLanguage(lang);
      const table: Loaded['table'] = [];
      const own = <T>(r: Record<string, T>, k: string) => (Object.hasOwn(r, k) ? r[k] : undefined);
      for (let id = 0; id < lang.nodeTypeCount; id++) {
        const type = lang.nodeTypeForId(id);
        if (!type) continue;
        const h: Handlers = {
          type,
          fn: own(spec.functions, type),
          con: own(spec.containers, type),
          call: own(spec.calls, type),
          imp: spec.imports && own(spec.imports, type),
        };
        if (h.fn || h.con || h.call || h.imp) table[id] = h;
      }
      return { parser, table };
    })();
    languages.set(spec.id, p);
  }
  return p;
}

export function hashCode(code: string): string {
  return createHash('sha1').update(code.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16);
}

/** Call refs are encoded as "recv|name" (recv may be empty) or "@address" (Terraform). */
export function encodeCall(name: string, recv?: string) {
  return `${recv ?? ''}|${name}`;
}

export const MODULE_NAME = '<module>';

/**
 * Parse one file and extract its function-like definitions with their call sites.
 * Top-level code (imports, globals, calls at module scope) becomes a synthetic `<module>` node.
 */
export async function extractFile(path: string, source: string): Promise<FnNode[] | null> {
  const spec = langForPath(path);
  if (!spec) return null;
  const { parser, table } = await parserFor(spec);
  const tree = parser.parse(source);
  try {
    return spec.custom ? extractTerraform(path, spec, tree.rootNode) : extractGeneric(path, spec, table, tree, source);
  } finally {
    tree.delete();
  }
}

function extractGeneric(path: string, spec: LangSpec, table: Loaded['table'], tree: Parser.Tree, source: string): FnNode[] {
  const out: FnNode[] = [];
  const seen = new Map<string, number>();
  const module: FnNode = {
    id: `${path}::${MODULE_NAME}`,
    name: MODULE_NAME,
    file: path,
    lang: spec.id,
    kind: 'module',
    startLine: 1,
    endLine: source.split('\n').length,
    hash: '',
    code: '',
    calls: [],
  };
  const fnStack: FnNode[] = [module];
  const containerStack: string[] = [];
  const topRanges: Array<[number, number]> = [];
  const selfVars = new Map<FnNode, string>(); // Go: receiver variable name acts like `self`

  const cursor = tree.walk();
  const visit = () => {
    do {
      const h = table[cursor.nodeTypeId];
      let pushedFn = false;
      let pushedCon = false;
      if (h) {
        const { type, fn: fnGet, con: conGet, call: callGet, imp } = h;
        const node = cursor.currentNode;
        if (imp) (module.imports ??= []).push(...imp(node));
        if (callGet) {
          const cur = fnStack[fnStack.length - 1];
          const selfVar = selfVars.get(cur);
          for (const c of callGet(node)) cur.calls.push(encodeCall(c.name, c.recv && c.recv === selfVar ? 'self' : c.recv));
        }
        if (conGet) {
          const name = conGet(node);
          if (name) {
            containerStack.push(name);
            pushedCon = true;
          }
        }
        if (fnGet) {
          const name = fnGet(node);
          if (name) {
            const goRecv = type === 'method_declaration' && spec.id === 'go' ? goReceiver(node) : undefined;
            const container = goRecv ? goRecv.type : containerStack[containerStack.length - 1];
            const base = `${path}::${container ? container + '.' : ''}${name}`;
            const n = (seen.get(base) ?? 0) + 1;
            seen.set(base, n);
            const code = node.text;
            const fn: FnNode = {
              id: n > 1 ? `${base}#${n}` : base,
              name,
              container: container ?? undefined,
              file: path,
              lang: spec.id,
              kind: container ? 'method' : 'function',
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
              hash: hashCode(code),
              code,
              calls: [],
            };
            if (goRecv?.name) selfVars.set(fn, goRecv.name);
            if (fnStack.length === 1) topRanges.push([node.startIndex, node.endIndex]);
            out.push(fn);
            fnStack.push(fn);
            pushedFn = true;
          }
        }
      }
      if (cursor.gotoFirstChild()) {
        visit();
        cursor.gotoParent();
      }
      if (pushedFn) fnStack.pop();
      if (pushedCon) containerStack.pop();
    } while (cursor.gotoNextSibling());
  };
  visit();
  cursor.delete();

  // Module body = file text with top-level function bodies cut out.
  let code = '';
  let pos = 0;
  for (const [s, e] of topRanges) {
    code += source.slice(pos, s) + '…';
    pos = e;
  }
  code += source.slice(pos);
  module.code = code;
  module.hash = hashCode(code);
  out.unshift(module);
  return out;
}

function goReceiver(node: Parser.SyntaxNode): { type: string; name?: string } | undefined {
  const param = node.childForFieldName('receiver')?.namedChildren.find((c) => c.type === 'parameter_declaration');
  const type = param?.descendantsOfType('type_identifier')[0]?.text;
  return type ? { type, name: param!.childForFieldName('name')?.text } : undefined;
}

// ---------- Terraform ----------

const TF_SKIP_ROOTS = new Set(['path', 'count', 'each', 'self', 'terraform']);

function tfLabels(block: Parser.SyntaxNode): string[] {
  return block.namedChildren
    .slice(1)
    .filter((c) => c.type === 'string_lit' || c.type === 'identifier')
    .map((c) => c.text.replace(/^"|"$/g, ''));
}

function tfRefs(node: Parser.SyntaxNode): string[] {
  const refs = new Set<string>();
  for (const v of node.descendantsOfType('variable_expr')) {
    const root = v.namedChild(0)?.text;
    if (!root || TF_SKIP_ROOTS.has(root)) continue;
    const attrs: string[] = [];
    let s = v.nextNamedSibling;
    while (s && s.type === 'get_attr' && attrs.length < 2) {
      const id = s.namedChild(0)?.text;
      if (id) attrs.push(id);
      s = s.nextNamedSibling;
    }
    let addr: string | null = null;
    if (root === 'var' || root === 'local' || root === 'module') addr = attrs[0] ? `${root}.${attrs[0]}` : null;
    else if (root === 'data') addr = attrs.length === 2 ? `data.${attrs[0]}.${attrs[1]}` : null;
    else addr = attrs[0] ? `${root}.${attrs[0]}` : null;
    if (addr) refs.add('@' + addr);
  }
  return [...refs];
}

function extractTerraform(path: string, spec: LangSpec, root: Parser.SyntaxNode): FnNode[] {
  const out: FnNode[] = [];
  const add = (addr: string, node: Parser.SyntaxNode, refsFrom: Parser.SyntaxNode) => {
    const code = node.text;
    out.push({
      id: `${path}::${addr}`,
      name: addr,
      file: path,
      lang: spec.id,
      kind: 'function',
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      hash: hashCode(code),
      code,
      calls: tfRefs(refsFrom),
    });
  };
  const body = root.namedChildren.find((c) => c.type === 'body');
  for (const block of body?.namedChildren ?? []) {
    if (block.type !== 'block') continue;
    const kind = block.namedChild(0)?.text;
    const labels = tfLabels(block);
    switch (kind) {
      case 'resource':
        if (labels.length >= 2) add(`${labels[0]}.${labels[1]}`, block, block);
        break;
      case 'data':
        if (labels.length >= 2) add(`data.${labels[0]}.${labels[1]}`, block, block);
        break;
      case 'module':
      case 'output':
      case 'provider':
        if (labels[0]) add(`${kind}.${labels[0]}`, block, block);
        break;
      case 'variable':
        if (labels[0]) add(`var.${labels[0]}`, block, block);
        break;
      case 'locals': {
        const inner = block.namedChildren.find((c) => c.type === 'body');
        for (const attr of inner?.namedChildren ?? []) {
          if (attr.type !== 'attribute') continue;
          const name = attr.namedChild(0)?.text;
          if (name) add(`local.${name}`, attr, attr);
        }
        break;
      }
    }
  }
  return out;
}
