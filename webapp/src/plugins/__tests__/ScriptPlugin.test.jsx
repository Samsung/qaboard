/**
 * Tests for the "Script" button: a snippet that lists the runs shown, from Python or the shell.
 * Run with: cd webapp && npm test -- ScriptPlugin
 */
import { screen, fireEvent, waitFor } from '@testing-library/react';

import { ScriptPlugin, runs_url, python_snippet, install_command } from '../ScriptPlugin';
import { renderWithProviders } from '../../test-utils';

vi.mock('copy-to-clipboard', () => ({ default: vi.fn() }));

describe('runs_url', () => {
  const origin = 'https://qaboard.example.com';

  it('keeps only what names the runs: project, commit, batch, filter', () => {
    expect(runs_url({ origin, project: 'kitefin/detector', commit_id: 'abc', batch: 'ci', filter: 'night -crash' }))
      .toBe('https://qaboard.example.com/kitefin/detector/commit/abc?batch=ci&filter=night+-crash');
    expect(runs_url({ origin, project: 'g/repo', commit_id: 'abc', batch: 'default' })).toBe('https://qaboard.example.com/g/repo/commit/abc?batch=default');
    // project ids and tags can have characters that need encoding
    expect(runs_url({ origin, project: 'g/my repo', commit_id: 'v1.0#rc', batch: 'ci' })).toBe('https://qaboard.example.com/g/my%20repo/commit/v1.0%23rc?batch=ci');
  });

  it('keeps the reference when the user picked one', () => {
    // the reference's batch defaults to "default" in the web app: "ci" must be written
    expect(runs_url({ origin, project: 'g/repo', commit_id: 'abc', batch: 'ci', ref_commit_id: 'def', batch_ref: 'ci', ref_project: 'g/repo' }))
      .toBe('https://qaboard.example.com/g/repo/commit/abc?batch=ci&reference=def&batch_ref=ci');
    expect(runs_url({ origin, project: 'g/repo', commit_id: 'abc', batch: 'ci', ref_commit_id: 'def', batch_ref: 'default' }))
      .toBe('https://qaboard.example.com/g/repo/commit/abc?batch=ci&reference=def');
    expect(runs_url({ origin, project: 'g/repo', commit_id: 'abc', batch: 'ci', ref_commit_id: 'def', batch_ref: 'nightly', filter_ref: 'indoor', ref_project: 'g/other' }))
      .toBe('https://qaboard.example.com/g/repo/commit/abc?batch=ci&reference=def&batch_ref=nightly&filter_ref=indoor&ref_project=g%2Fother');
  });
});

describe('ScriptPlugin', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows a Python snippet with the page\'s address, then a shell one', async () => {
    renderWithProviders(<ScriptPlugin project="g/repo" commit_id="abc" batch="ci" filter="night"/>);
    expect(screen.queryByTestId('script-snippet')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Use the runs in a script' }));
    const snippet = await screen.findByTestId('script-snippet');
    const url = `${window.location.origin}/g/repo/commit/abc?batch=ci&filter=night`;
    expect(snippet).toHaveTextContent(`qb.runs("${url}")`);
    expect(snippet.textContent).toBe(python_snippet(url));
    fireEvent.click(screen.getByRole('radio', { name: 'Shell' }));
    expect(screen.getByTestId('script-snippet')).toHaveTextContent(`qa runs "${url}"`);
  });

  it('lists what the site installs, e.g. its site package', async () => {
    const requirements = ['qaboard', 'qaboard-site-acme @ git+ssh://git@git.example.com/infra/qaboard#subdirectory=deployments/acme/cli'];
    vi.spyOn(globalThis, 'fetch').mockImplementation(url => String(url).includes('/api/v1/config')
      ? Promise.resolve(new Response(JSON.stringify({ cli_requirements: requirements }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      : Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })));
    renderWithProviders(<ScriptPlugin project="g/repo" commit_id="abc" batch="ci"/>);
    fireEvent.click(screen.getByRole('button', { name: 'Use the runs in a script' }));
    const snippet = await screen.findByTestId('script-snippet');
    await waitFor(() => expect(snippet.textContent).toContain('qaboard-site-acme @ git+ssh'));
    expect(snippet.textContent.startsWith('# /// script\n# dependencies = ["qaboard", "qaboard-site-acme @ git+ssh://git@git.example.com/infra/qaboard#subdirectory=deployments/acme/cli"]\n# ///\n')).toBe(true);
    expect(screen.getByTestId('install-command')).toHaveTextContent("pip install --upgrade qaboard 'qaboard-site-acme @ git+ssh://git@git.example.com/infra/qaboard#subdirectory=deployments/acme/cli'");
    expect(install_command(['qaboard'])).toBe('pip install --upgrade qaboard');
  });

  it('copies the snippet', async () => {
    const copy = (await import('copy-to-clipboard')).default;
    renderWithProviders(<ScriptPlugin project="g/repo" commit_id="abc" batch="ci"/>);
    fireEvent.click(screen.getByRole('button', { name: 'Use the runs in a script' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Copy' }));
    expect(copy).toHaveBeenCalledWith(expect.stringContaining('qb.runs('), expect.anything());
  });
});
