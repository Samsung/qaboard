// Shot ids, output folders and selection (docs-media/README.md#shot-ids)
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type ShotId = `${string}/${string}`;

export const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*\/[a-z0-9]+(-[a-z0-9]+)*$/;
export const ID_MAX_LENGTH = 80;

// Adding an area means editing this list and the README's
export const AREAS = [
  'quickstart', 'cli', 'ci', 'projects', 'commits', 'integrations', 'commit', 'logs', 'history', 'tuning', 'files',
  'whats-new', 'auth', 'landing',
] as const;

export function checkId(id: string): asserts id is ShotId {
  if (!ID_RE.test(id) || id.length > ID_MAX_LENGTH)
    throw new Error(`Invalid shot id "${id}": expected <area>/<subject> in lowercase kebab-case, at most ${ID_MAX_LENGTH} characters`);
  const area = id.split('/')[0];
  if (!(AREAS as readonly string[]).includes(area))
    throw new Error(`Unknown area "${area}" in shot id "${id}". Areas: ${AREAS.join(', ')} (docs-media/README.md#shot-ids)`);
}

// docs-media/
export const DOCS_MEDIA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const REPO_ROOT = path.resolve(DOCS_MEDIA_DIR, '..');

// Where captures go: docs-media/out/<area>/<subject>/. SHOTS_OUT overrides the root (tests use it).
export function outRoot(): string {
  return process.env.SHOTS_OUT ? path.resolve(process.env.SHOTS_OUT) : path.join(DOCS_MEDIA_DIR, 'out');
}

// Dark captures go in a dark/ folder inside the light one's: docs-media/out/<area>/<subject>/dark/
export function outDir(id: ShotId, theme: 'light' | 'dark' = 'light'): string {
  return path.join(outRoot(), ...id.split('/'), ...(theme === 'dark' ? ['dark'] : []));
}

// A glob over ids, like the workflow's `only` input: `*` matches anything, `?` one character, `,` separates globs.
// `commit/*` and `commit/image-*,history/*` work. Empty or `*` selects everything.
export function globToRegExp(glob: string): RegExp {
  const parts = glob.split(',').map(g => g.trim()).filter(Boolean);
  if (parts.length === 0) return /^/;
  const one = (g: string) => g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^(?:${parts.map(one).join('|')})$`);
}

// SHOTS_ONLY=<glob> registers only the matching shots
export function isSelected(id: string, only = process.env.SHOTS_ONLY): boolean {
  if (!only || only.trim() === '' || only.trim() === '*') return true;
  return globToRegExp(only).test(id);
}

// The spec file that registered a shot, as written in the manifest: docs-media/shots/commit.spec.ts
export function sourceSpec(file: string): string {
  const relative = path.relative(REPO_ROOT, file).split(path.sep).join('/');
  return relative;
}

// The spec file calling shot()/clip(): the first file in the stack outside lib/
export function callerFile(): string {
  const libDir = path.dirname(fileURLToPath(import.meta.url));
  for (const line of (new Error().stack ?? '').split('\n').slice(1)) {
    const match = /\(?((?:file:\/\/)?\/[^():]+):\d+:\d+\)?\s*$/.exec(line);
    if (!match) continue;
    const file = match[1].startsWith('file://') ? fileURLToPath(match[1]) : match[1];
    if (!file.startsWith(libDir + path.sep) && !file.includes(`${path.sep}node_modules${path.sep}`)) return file;
  }
  throw new Error('[shots] could not find the spec file that registered the shot');
}
