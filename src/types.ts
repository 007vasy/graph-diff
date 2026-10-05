export type FnId = string;
export type Status = 'added' | 'removed' | 'modified' | 'unchanged';

export interface FnNode {
  id: FnId;
  name: string;
  container?: string;
  file: string;
  lang: string;
  kind: 'function' | 'method' | 'module';
  startLine: number;
  endLine: number;
  hash: string;
  code: string;
  calls: string[];
  /** module nodes only: identifiers bound by imports (package names / aliases / namespaces) */
  imports?: string[];
}

export interface CallGraph {
  nodes: Map<FnId, FnNode>;
  edges: Set<string>; // "from->to"
}

export interface FileChange {
  path: string;
  oldPath?: string;
  status: 'added' | 'removed' | 'modified' | 'renamed';
  added: number;
  removed: number;
  binary: boolean;
}

export interface PatchLine {
  t: '+' | '-' | ' ' | '@';
  o?: number; // old line number
  n?: number; // new line number
  s: string;
}

export interface PrInfo {
  key: string;
  owner?: string;
  repo?: string;
  number?: number;
  title: string;
  author?: string;
  url?: string;
  baseRef?: string;
  headRef?: string;
  baseSha?: string;
  headSha?: string;
  isDraft?: boolean;
  updatedAt?: string;
  local?: { cwd: string; base: string; head: string };
}

export interface Stats {
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  fnAdded: number;
  fnRemoved: number;
  fnModified: number;
  edgesAdded: number;
  edgesRemoved: number;
  languages: Record<string, number>;
  parsedFiles: { base: number; head: number };
  skippedFiles: number;
  coverage: {
    staticCovered: number;
    staticTotal: number;
    lcov?: { coveredLines: number; totalLines: number; source: string };
  };
  analysisMs: number;
}

export interface GraphNode {
  id: string;
  label: string;
  type: 'function' | 'file' | 'folder';
  kind?: FnNode['kind'];
  status: Status;
  file?: string;
  lang?: string;
  line?: number;
  depth: number;
  added?: number;
  removed?: number;
  patch?: PatchLine[];
  patchTruncated?: boolean;
  covered?: boolean | null;
  lcov?: { covered: number; total: number } | null;
  isTest?: boolean;
  /** set for hub nodes: number of call-graph neighbours (not expanded beyond) */
  degree?: number;
}

export interface GraphLink {
  source: string;
  target: string;
  type: 'call' | 'contains';
  status: Status;
}

export interface GraphPayload {
  pr: PrInfo;
  stats: Stats;
  files: FileChange[];
  nodes: GraphNode[];
  links: GraphLink[];
  maxDepth: number;
}
