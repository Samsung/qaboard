// Facts about the restored demo snapshot (examples/README.md), and URL builders matching the web app's routes
// (webapp/src/routes.js) and query parameters (webapp/src/defaults.js, webapp/src/actions/selected.js).
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './ids';

export type ProjectKey = 'image-quality' | 'serving-latency' | 'detection-eval' | 'robotics-3d' | 'agent-evals';
// The app's `selected_views` values (webapp/src/AppSider.jsx)
export type View = 'summary' | 'table-kpi' | 'table-compare' | 'output-list' | 'bit_accuracy' | 'logs'
  | 'parameters' | 'groups' | 'tuning' | 'optimization';

export type Query = Record<string, string | number | boolean | undefined | null>;

export interface CommitUrlOptions {
  reference?: string;                                  // story commit id; default: the app's default reference
  view?: View; batch?: string; batch_ref?: string; filter?: string; filter_ref?: string;
  controls?: Record<string, unknown>;                  // serialized as the app's `controls` JSON parameter
  query?: Record<string, string>;                      // anything else the app keeps in the URL
}

/** Facts about the restored demo snapshot (examples/README.md). */
export interface Demo {
  t0: Date;
  baseUrl: string;                                     // http://localhost:5151
  appVersion: string;                                  // 1.1.1+78813fe
  slug(project: ProjectKey): string;                   // 'kitefin/inference-gateway'
  sha(project: ProjectKey, commit: string): string;    // story commit id -> 40-hex sha (see examples/STORY.md)
  url(project: ProjectKey, path?: string, query?: Query): string;
  commitUrl(project: ProjectKey, commit: string, opts?: CommitUrlOptions): string;
  historyUrl(project: ProjectKey, branch: string, query?: Record<string, string>): string;
  filesUrl(project: ProjectKey, commit: string, relativePath?: string): string;   // the /s/ file browser
}

// examples/README.md#projects: the project ids are part of the demo world's contract
export const PROJECT_IDS: Record<ProjectKey, string> = {
  'image-quality': 'kitefin/camera-isp',
  'serving-latency': 'kitefin/inference-gateway',
  'detection-eval': 'kitefin/detector',
  'robotics-3d': 'kitefin/slam',
  'agent-evals': 'kitefin/fleet-assistant',
};

// Who is logged in by default when a shot shows a project: its main author (examples/README.md#people)
export const PROJECT_PERSONAS: Record<ProjectKey, string> = {
  'image-quality': 'ines',
  'serving-latency': 'adaeze',
  'detection-eval': 'arjun',
  'robotics-3d': 'mira',
  'agent-evals': 'kaito',
};

// Every persona's password in the demo stack (docs-media/seed.py)
export const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'kitefin-demo';

/**
 * The demo facts: what docs-media/seed.py writes in <results>/.qaboard-demo/demo.json (snapshots restore it):
 * T0, and each project's id and commits. The environment can override or complete them:
 * DEMO_META (another file), DEMO_T0, DEMO_BASE_URL (default http://localhost:$QABOARD_DEMO_PORT, 5151),
 * DEMO_APP_VERSION (default: pyproject.toml's version + the checkout's short sha), QABOARD_DEMO_RESULTS (/mnt/qaboard).
 */
export interface DemoFacts {
  t0: string;                                          // ISO 8601, a Thursday 16:00 UTC: "2026-10-08T16:00:00Z"
  base_url?: string;
  app_version?: string;
  storage?: string;                                    // the results storage, as the server sees it
  projects?: Partial<Record<ProjectKey, {
    id?: string;
    commits?: Record<string, { sha: string }>;         // story commit id -> sha
    files_root?: string;                               // default <storage>/<project id>
  }>>;
}

export function demoFactsPath(): string {
  if (process.env.DEMO_META) return path.resolve(process.env.DEMO_META);
  return path.join(process.env.QABOARD_DEMO_RESULTS || '/mnt/qaboard', '.qaboard-demo', 'demo.json');
}

export function loadDemoFacts(): DemoFacts {
  const file = demoFactsPath();
  let facts: Partial<DemoFacts> = {};
  if (fs.existsSync(file))
    facts = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (process.env.DEMO_T0) facts.t0 = process.env.DEMO_T0;
  facts.base_url = process.env.DEMO_BASE_URL || facts.base_url || `http://localhost:${process.env.QABOARD_DEMO_PORT || 5151}`;
  if (process.env.DEMO_APP_VERSION) facts.app_version = process.env.DEMO_APP_VERSION;
  facts.storage ??= process.env.QABOARD_DEMO_RESULTS || '/mnt/qaboard';
  if (!facts.t0)
    throw new Error(`No demo facts: ${file} doesn't exist and DEMO_T0 isn't set. Restore a snapshot first `
      + '(uv run docs-media/snapshot.py restore), see docs-media/README.md#the-demo-stack-and-its-data');
  return facts as DemoFacts;
}

// qaboard's version plus the short sha of the checkout the stack was built from: 1.1.1+78813fe
export function localAppVersion(): string {
  const pyproject = fs.readFileSync(path.join(REPO_ROOT, 'pyproject.toml'), 'utf8');
  const version = /^version\s*=\s*"([^"]+)"/m.exec(pyproject)?.[1] ?? '0.0.0';
  try {
    const sha = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
    return `${version}+${sha}`;
  } catch {
    return version;
  }
}

const encodePath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

export function queryString(query?: Query): string {
  const entries = Object.entries(query ?? {}).filter(([, v]) => v !== undefined && v !== null);
  if (entries.length === 0) return '';
  return '?' + entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
}

export function createDemo(facts: DemoFacts): Demo {
  const t0 = new Date(facts.t0);
  if (Number.isNaN(t0.getTime())) throw new Error(`Invalid T0 in the demo facts: ${facts.t0}`);
  const baseUrl = (facts.base_url ?? 'http://localhost:5151').replace(/\/+$/, '');
  const storage = (facts.storage ?? '/mnt/qaboard').replace(/\/+$/, '');
  const slug = (project: ProjectKey) => {
    const id = facts.projects?.[project]?.id ?? PROJECT_IDS[project];
    if (!id) throw new Error(`Unknown demo project "${project}"`);
    return id;
  };
  // examples/STORY.md: sha1("<project id>:<commit id>"). When the facts list the project's commits, an id that isn't
  // there is a typo (or a commit the snapshot doesn't have): better fail than capture an error page.
  const sha = (project: ProjectKey, commit: string) => {
    if (/^[0-9a-f]{40}$/.test(commit)) return commit;
    const commits = facts.projects?.[project]?.commits;
    if (commits && !commits[commit])
      throw new Error(`[shots] "${commit}" isn't a commit of ${project} in the demo snapshot: ${Object.keys(commits).join(', ')}`);
    return commits?.[commit]?.sha ?? createHash('sha1').update(`${slug(project)}:${commit}`).digest('hex');
  };
  const url = (project: ProjectKey, p?: string, query?: Query) => {
    const suffix = p ? `/${encodePath(p.replace(/^\/+/, ''))}` : '';
    return `${baseUrl}/${encodePath(slug(project))}${suffix}${queryString(query)}`;
  };
  return {
    t0,
    baseUrl,
    appVersion: facts.app_version ?? localAppVersion(),
    slug,
    sha,
    url,
    // /:project_id+/commit/:commit with the parameters CiCommitResults reads (webapp/src/defaults.js)
    commitUrl(project, commit, opts = {}) {
      const query: Query = {
        reference: opts.reference ? sha(project, opts.reference) : undefined,
        selected_views: opts.view,
        batch: opts.batch,
        batch_ref: opts.batch_ref,
        filter: opts.filter,
        filter_ref: opts.filter_ref,
        controls: opts.controls ? JSON.stringify(opts.controls) : undefined,
        ...opts.query,
      };
      return url(project, `commit/${sha(project, commit)}`, query);
    },
    // /:project_id+/history/:branch+
    historyUrl(project, branch, query) {
      return url(project, `history/${branch}`, query);
    },
    // nginx serves the results under /s/ (webapp/src/files/logic.js), the commit's folder is
    // <storage>/<project id>/<sha[:2]>/<sha[2:16]>/ (qaboard/conventions.py:get_commit_dirs)
    filesUrl(project, commit, relativePath = '') {
      const s = sha(project, commit);
      const root = (facts.projects?.[project]?.files_root ?? `${storage}/${slug(project)}`).replace(/\/+$/, '');
      const rel = relativePath.replace(/^\/+/, '');
      const folder = `${root}/${s.slice(0, 2)}/${s.slice(2, 16)}/${rel}`;
      return `${baseUrl}/s${encodePath(folder)}`;
    },
  };
}

let cached: Demo | undefined;
export function demo(): Demo {
  cached ??= createDemo(loadDemoFacts());
  return cached;
}
