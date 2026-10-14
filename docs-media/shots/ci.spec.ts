// What QA-Board shows in CI (docs-media/shots.yaml: ci/*).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { marked } from 'marked';
import { shot, type Demo } from './lib';

const SL = 'serving-latency';
const require = createRequire(import.meta.url);
const REPO = path.resolve(import.meta.dirname, '..', '..');

// `qa gate --format markdown`, what it appends to $GITHUB_STEP_SUMMARY in a GitHub Actions job, run for real against
// the demo stack: this checkout's qa, from the example's folder (its qaboard.yaml has the gate's rules)
function gateSummary(d: Demo, commit: string, reference: string): string {
  const args = ['run', '-q', '--no-project', '--with-editable', REPO, 'qa', 'gate', '--format', 'markdown',
    '--commit', d.sha(SL, commit), '--reference', d.sha(SL, reference), '--server', d.baseUrl];
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CI|GITHUB_.*|GITLAB_.*|QA_.*|QABOARD_.*)$/.test(k)));
  try {
    return execFileSync('uv', args, { cwd: path.join(REPO, 'examples', SL), env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (error) {
    // a failing gate exits with 1, its summary is on stdout all the same
    const { status, stdout } = error as { status?: number; stdout?: string };
    if (status === 1 && stdout) return stdout;
    throw error;
  }
}

// The summary as GitHub renders Markdown (github-markdown-css), without the rest of GitHub's page
function summaryPage(markdown: string): string {
  const css = fs.readFileSync(require.resolve('github-markdown-css/github-markdown-light.css'), 'utf8');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Job summary</title><style>${css}
    body { margin: 0; background: #fff; }
    .markdown-body { box-sizing: border-box; width: 880px; padding: 24px 32px; }
  </style></head><body><article class="markdown-body">${marked.parse(markdown, { async: false })}</article></body></html>`;
}

shot('ci/step-summary', {
  project: SL,
  login: null,
  url: d => `data:text/html;base64,${Buffer.from(summaryPage(gateSummary(d, 'cache-shared', 'batch-overflow-fix'))).toString('base64')}`,
  alt: 'The quality gate\'s summary in a CI job: "Quality gate: fail", the commit against its reference with a link to '
    + 'the Metrics Diff, and a table of the checks: p99 dozens of times the reference\'s for a 10% limit, FAIL; '
    + 'throughput and failed runs pass.',
  caption: 'In GitHub Actions, qa gate adds its verdict and table to the job\'s summary.',
  viewport: { width: 960, height: 600 },
  target: page => page.locator('article.markdown-body'),
  padding: 0,
});
