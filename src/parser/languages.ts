import type Parser from 'web-tree-sitter';

type Node = Parser.SyntaxNode;

/** A call site: callee name plus optional simple receiver (`recv.name(...)`). */
export interface CallRef {
  name: string;
  recv?: string;
}

export interface LangSpec {
  id: string;
  wasm: string; // path relative to node_modules
  exts: string[];
  /** node type → definition name (null = anonymous, not a definition) */
  functions: Record<string, (n: Node) => string | null>;
  /** node type → container (class/impl/contract) name */
  containers: Record<string, (n: Node) => string | null>;
  /** node type → call refs found at this node */
  calls: Record<string, (n: Node) => CallRef[]>;
  /** node type → identifiers bound by an import at this node */
  imports?: Record<string, (n: Node) => string[]>;
  /** names that act as constructors when a container is "called" */
  ctorNames?: string[];
  /** custom extractor (used by Terraform, which has no functions or calls) */
  custom?: true;
}

const field = (f: string) => (n: Node) => n.childForFieldName(f)?.text ?? null;
const SIMPLE = /^[A-Za-z_$][\w$]*$/;
/** Receiver of a member call: a simple identifier, or '?' when it is an expression (`a.b.c()`, `f().g()`). */
const recvOf = (n: Node | null | undefined) => (n && SIMPLE.test(n.text) ? n.text : '?');
const firstNamed = (n: Node) => n.namedChild(0);

// ---------- JavaScript / TypeScript ----------

function jsBoundName(n: Node): string | null {
  const p = n.parent;
  if (!p) return null;
  switch (p.type) {
    case 'variable_declarator':
      return p.childForFieldName('name')?.text ?? null;
    case 'pair':
      return p.childForFieldName('key')?.text.replace(/['"`]/g, '') ?? null;
    case 'public_field_definition':
    case 'field_definition':
      return (p.childForFieldName('name') ?? p.childForFieldName('property'))?.text ?? null;
    case 'assignment_expression': {
      const left = p.childForFieldName('left');
      if (!left) return null;
      if (left.type === 'member_expression') return left.childForFieldName('property')?.text ?? null;
      return SIMPLE.test(left.text) ? left.text : null;
    }
    case 'export_statement':
      return 'default';
  }
  return null;
}

function jsCall(n: Node): CallRef[] {
  const fn = n.childForFieldName('function');
  if (!fn) return [];
  if (fn.type === 'identifier') return [{ name: fn.text }];
  if (fn.type === 'member_expression') {
    const prop = fn.childForFieldName('property');
    if (prop) return [{ name: prop.text, recv: recvOf(fn.childForFieldName('object')) }];
  }
  return [];
}

function jsNew(n: Node): CallRef[] {
  const c = n.childForFieldName('constructor');
  return c && SIMPLE.test(c.text) ? [{ name: 'constructor', recv: c.text }] : [];
}

function jsImport(n: Node): string[] {
  const clause = n.namedChildren.find((c) => c.type === 'import_clause');
  if (!clause) return [];
  const out: string[] = [];
  for (const c of clause.namedChildren) {
    if (c.type === 'identifier') out.push(c.text);
    else if (c.type === 'namespace_import') out.push(c.namedChildren.find((x) => x.type === 'identifier')?.text ?? '');
  }
  return out.filter(Boolean);
}

const jsImports: LangSpec['imports'] = { import_statement: jsImport };

const jsFunctions: LangSpec['functions'] = {
  function_declaration: field('name'),
  generator_function_declaration: field('name'),
  method_definition: field('name'),
  arrow_function: jsBoundName,
  function_expression: (n) => n.childForFieldName('name')?.text ?? jsBoundName(n),
  function: (n) => n.childForFieldName('name')?.text ?? jsBoundName(n),
};
const jsContainers: LangSpec['containers'] = {
  class_declaration: field('name'),
  abstract_class_declaration: field('name'),
  class: (n) => n.childForFieldName('name')?.text ?? jsBoundName(n),
};
const jsCalls: LangSpec['calls'] = { call_expression: jsCall, new_expression: jsNew };

// ---------- Go ----------

function goImport(n: Node): string[] {
  const alias = n.childForFieldName('name')?.text;
  if (alias) return alias === '_' || alias === '.' ? [] : [alias];
  const segs = (n.childForFieldName('path')?.text ?? '').replace(/"/g, '').split('/');
  let last = segs.pop() ?? '';
  if (/^v\d+$/.test(last) && segs.length) last = segs.pop()!; // module/v2 → module
  return last ? [last.replace(/^go-/, '').replace(/[.-].*$/, '')] : [];
}

function goReceiverType(n: Node): string | null {
  const recv = n.childForFieldName('receiver');
  if (!recv) return null;
  const t = recv.descendantsOfType('type_identifier')[0];
  return t?.text ?? null;
}

function goCall(n: Node): CallRef[] {
  const fn = n.childForFieldName('function');
  if (!fn) return [];
  if (fn.type === 'identifier') return [{ name: fn.text }];
  if (fn.type === 'selector_expression') {
    const f = fn.childForFieldName('field');
    if (f) return [{ name: f.text, recv: recvOf(fn.childForFieldName('operand')) }];
  }
  return [];
}

// ---------- Python ----------

function pyImport(n: Node): string[] {
  const out: string[] = [];
  for (const c of n.namedChildren) {
    if (n.type === 'import_from_statement' && c === n.childForFieldName('module_name')) continue;
    if (c.type === 'aliased_import') out.push(c.childForFieldName('alias')?.text ?? '');
    else if (c.type === 'dotted_name') out.push(n.type === 'import_statement' ? c.text.split('.')[0] : c.text.split('.').pop()!);
  }
  return out.filter(Boolean);
}

function pyCall(n: Node): CallRef[] {
  const fn = n.childForFieldName('function');
  if (!fn) return [];
  if (fn.type === 'identifier') return [{ name: fn.text }];
  if (fn.type === 'attribute') {
    const a = fn.childForFieldName('attribute');
    if (a) return [{ name: a.text, recv: recvOf(fn.childForFieldName('object')) }];
  }
  return [];
}

// ---------- Rust ----------

function rustImplType(n: Node): string | null {
  const t = n.childForFieldName('type');
  if (!t) return null;
  if (t.type === 'type_identifier') return t.text;
  return t.descendantsOfType('type_identifier')[0]?.text ?? t.text;
}

function rustCall(n: Node): CallRef[] {
  let fn = n.childForFieldName('function');
  if (!fn) return [];
  if (fn.type === 'generic_function') fn = fn.childForFieldName('function') ?? fn;
  if (fn.type === 'identifier') return [{ name: fn.text }];
  if (fn.type === 'field_expression') {
    const f = fn.childForFieldName('field');
    if (f) return [{ name: f.text, recv: recvOf(fn.childForFieldName('value')) }];
  }
  if (fn.type === 'scoped_identifier') {
    const name = fn.childForFieldName('name');
    const path = fn.childForFieldName('path');
    const last = path?.text.split('::').pop();
    if (name) return [{ name: name.text, recv: last === 'Self' ? 'self' : last }];
  }
  return [];
}

// ---------- Solidity ----------

function solCall(n: Node): CallRef[] {
  const fn = n.childForFieldName('function') ?? firstNamed(n);
  if (!fn) return [];
  if (fn.type === 'identifier') return [{ name: fn.text }];
  if (fn.type === 'member_expression') {
    const prop = fn.childForFieldName('property') ?? fn.namedChild(fn.namedChildCount - 1);
    const obj = fn.childForFieldName('object') ?? fn.namedChild(0);
    if (prop) return [{ name: prop.text, recv: recvOf(obj) }];
  }
  if (fn.type === 'new_expression') {
    const t = fn.descendantsOfType('identifier')[0];
    return t ? [{ name: 'constructor', recv: t.text }] : [];
  }
  return [];
}

function solModifier(n: Node): CallRef[] {
  const id = firstNamed(n);
  return id && SIMPLE.test(id.text) ? [{ name: id.text }] : [];
}

// ---------- Java ----------

function javaCall(n: Node): CallRef[] {
  const name = n.childForFieldName('name');
  return name ? [{ name: name.text, recv: recvOf(n.childForFieldName('object')) }] : [];
}

export const LANGS: LangSpec[] = [
  {
    id: 'typescript',
    wasm: 'tree-sitter-wasms/out/tree-sitter-typescript.wasm',
    exts: ['.ts', '.mts', '.cts'],
    functions: jsFunctions,
    containers: jsContainers,
    calls: jsCalls,
    imports: jsImports,
    ctorNames: ['constructor'],
  },
  {
    id: 'tsx',
    wasm: 'tree-sitter-wasms/out/tree-sitter-tsx.wasm',
    exts: ['.tsx'],
    functions: jsFunctions,
    containers: jsContainers,
    calls: jsCalls,
    imports: jsImports,
    ctorNames: ['constructor'],
  },
  {
    id: 'javascript',
    wasm: 'tree-sitter-wasms/out/tree-sitter-javascript.wasm',
    exts: ['.js', '.jsx', '.mjs', '.cjs'],
    functions: jsFunctions,
    containers: jsContainers,
    calls: jsCalls,
    imports: jsImports,
    ctorNames: ['constructor'],
  },
  {
    id: 'go',
    wasm: 'tree-sitter-wasms/out/tree-sitter-go.wasm',
    exts: ['.go'],
    functions: { function_declaration: field('name'), method_declaration: field('name') },
    containers: {},
    calls: { call_expression: goCall },
    imports: { import_spec: goImport },
  },
  {
    id: 'python',
    wasm: 'tree-sitter-wasms/out/tree-sitter-python.wasm',
    exts: ['.py'],
    functions: { function_definition: field('name') },
    containers: { class_definition: field('name') },
    calls: { call: pyCall },
    imports: { import_statement: pyImport, import_from_statement: pyImport },
    ctorNames: ['__init__'],
  },
  {
    id: 'rust',
    wasm: 'tree-sitter-wasms/out/tree-sitter-rust.wasm',
    exts: ['.rs'],
    functions: { function_item: field('name') },
    containers: { impl_item: rustImplType, trait_item: field('name') },
    calls: { call_expression: rustCall },
    ctorNames: ['new'],
  },
  {
    id: 'solidity',
    wasm: 'tree-sitter-wasms/out/tree-sitter-solidity.wasm',
    exts: ['.sol'],
    functions: {
      function_definition: (n) => n.childForFieldName('name')?.text ?? firstNamed(n)?.text ?? null,
      modifier_definition: (n) => n.childForFieldName('name')?.text ?? firstNamed(n)?.text ?? null,
      constructor_definition: () => 'constructor',
      fallback_receive_definition: (n) => (n.text.trimStart().startsWith('receive') ? 'receive' : 'fallback'),
    },
    containers: {
      contract_declaration: field('name'),
      interface_declaration: field('name'),
      library_declaration: field('name'),
    },
    calls: { call_expression: solCall, modifier_invocation: solModifier },
    ctorNames: ['constructor'],
  },
  {
    id: 'java',
    wasm: 'tree-sitter-wasms/out/tree-sitter-java.wasm',
    exts: ['.java'],
    functions: { method_declaration: field('name'), constructor_declaration: field('name') },
    containers: {
      class_declaration: field('name'),
      interface_declaration: field('name'),
      enum_declaration: field('name'),
      record_declaration: field('name'),
    },
    calls: {
      method_invocation: javaCall,
      object_creation_expression: (n) => {
        const t = n.childForFieldName('type');
        return t && SIMPLE.test(t.text) ? [{ name: t.text }] : [];
      },
    },
  },
  {
    id: 'terraform',
    wasm: '@tree-sitter-grammars/tree-sitter-hcl/tree-sitter-terraform.wasm',
    exts: ['.tf'],
    functions: {},
    containers: {},
    calls: {},
    custom: true,
  },
];

const BY_EXT = new Map<string, LangSpec>();
for (const l of LANGS) for (const e of l.exts) BY_EXT.set(e, l);

export function langForPath(path: string): LangSpec | undefined {
  if (path.endsWith('.d.ts')) return undefined;
  const i = path.lastIndexOf('.');
  return i < 0 ? undefined : BY_EXT.get(path.slice(i).toLowerCase());
}
