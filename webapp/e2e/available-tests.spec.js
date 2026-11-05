// The "Available Tests" view, that edits the files defining batches, against a mocked API.
import { test, expect } from '@playwright/test';

const project = 'group/repo';
const qatools_config = { inputs: { batches: ['qa/batches.yaml'], database: { linux: '/mnt/database' } } };
const commit = {
  id: 'abc123', hexsha: 'abc123', project_id: project, branch: 'master',
  committer_name: 'Alice', message: 'Hello world',
  authored_datetime: '2026-09-01T10:00:00Z', committed_datetime: '2026-09-01T10:00:00Z',
  latest_output_datetime: '2026-09-01T10:00:00Z',
  batches: {}, data: { qatools_config }, parents: [],
};

// Longest matching prefix wins
const api = {
  '/api/v1/config': {},
  '/api/v1/user/me/': { is_authenticated: true, user_id: 1, user_name: 'alice', full_name: 'Alice', email: 'alice@example.com', login_type: 'local' },
  '/api/v1/projects': { [project]: { id: project, data: { qatools_config }, latest_commit_datetime: '2026-09-01T10:00:00Z', total_commits: 1 } },
  '/api/v1/project': { id: project, data: { qatools_config } },
  '/api/v1/project/branches': ['master'],
  '/api/v1/commits': [commit],
  '/api/v1/commit': commit,
  '/api/v1/tests/group': { tests: [
    { input_path: 'images/A.jpg', configurations: ['base'] },
    { input_path: 'images/B.jpg', configurations: ['base', { threshold: 2 }] },
  ] },
};

test.beforeEach(async ({ page }) => {
  // the "What's new" dialog would take the focus while we type
  await page.addInitScript(() => localStorage.setItem('qaboard.release-notes.last-seen', '9999-12-31'));
});

test('edit, check and save batches', async ({ page }) => {
  const errors = [];
  page.on('console', msg => msg.type() === 'error' && errors.push(msg.text()));
  page.on('pageerror', error => errors.push(error.message));

  const files = {
    alice: '# my batches\nmy-batch:\n  inputs:\n  - images/A.jpg\n  - images/B.jpg\n',
    'extra-batches': 'shared-batch:\n  inputs: [images/C.jpg]\n',
  };
  const saved = [];
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/v1/tests/groups') {
      const name = url.searchParams.get('name');
      if (route.request().method() === 'POST') {
        files[name] = route.request().postDataJSON().groups;
        saved.push(name);
        return route.fulfill({ json: 'OK' });
      }
      return route.fulfill({ body: files[name], contentType: 'text/html' });
    }
    const key = Object.keys(api).sort((a, b) => b.length - a.length).find(k => url.pathname.startsWith(k));
    return route.fulfill({ json: key ? api[key] : {} });
  });

  await page.goto(`/${project}/commit/abc123?selected_views=groups`);
  const outline = page.getByRole('list', { name: 'Batches' });
  await expect(outline.getByText('my-batch')).toBeVisible();
  await expect(outline.getByText('2 inputs')).toBeVisible();
  await expect(page.getByText('No changes')).toBeVisible();

  // YAML problems show while typing
  // Monaco is loaded lazily: wait for it to show the file
  const editor = page.locator('.monaco-editor').first();
  await expect(editor.locator('.view-lines')).toContainText('my batches');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  // (typing would close the bracket)
  await page.keyboard.insertText('\nbroken: [a');
  await expect(page.getByRole('button', { name: '1 error' })).toBeVisible();
  await expect(page.getByText('Unsaved changes')).toBeVisible();

  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText('my-batch: {inputs: [images/A.jpg, images/B.jpg]}');
  await expect(page.getByRole('button', { name: /error/ })).toHaveCount(0);
  // Keys that are shortcuts elsewhere ("/" opens the command palette) type in the editor.
  // Keystrokes: insertText() sends no keydown. Monaco types in an EditContext <div> in Chromium, not a textarea.
  await page.keyboard.type(' # a/b?');
  await expect(editor.locator('.view-lines')).toContainText('# a/b?');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'New batch' }).click();
  await expect(outline.getByText('my-new-batch')).toBeVisible();
  await expect(outline.getByText('1 input', { exact: true })).toBeVisible();

  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.getByText('Saved just now')).toBeVisible();
  expect(saved).toEqual(['alice']);
  expect(files.alice).toBe('my-batch: {inputs: [images/A.jpg, images/B.jpg]} # a/b?\n\nmy-new-batch:\n  inputs:\n  - path/to/an/input\n');

  // Which tests run?
  await outline.getByText('my-batch').hover();
  await page.getByLabel('List the tests in my-batch').click();
  const drawer = page.locator('.bp6-drawer');
  await expect(drawer.getByText('2 tests')).toBeVisible();
  await expect(drawer.getByText('images/B.jpg')).toBeVisible();
  await expect(drawer.getByText('{"threshold":2}')).toBeVisible();

  expect(errors, 'errors in the browser console').toEqual([]);
});

test('toasts show in the window, even after scrolling down', async ({ page }) => {
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/v1/tests/groups')
      return route.fulfill({ body: 'my-batch:\n  inputs: [a.jpg]\n', contentType: 'text/html' });
    const key = Object.keys(api).sort((a, b) => b.length - a.length).find(k => url.pathname.startsWith(k));
    return route.fulfill({ json: key ? api[key] : {} });
  });
  await page.goto(`/${project}/commit/abc123?selected_views=groups`);
  await page.getByLabel('Copy the path').click();
  // e.g. lots of failed runs, as when this bug was reported
  await page.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', '<div style="height: 5000px"></div>');
    window.scrollTo(0, document.body.scrollHeight);
  });
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(4000);
  const toast = page.locator('.bp6-toast').filter({ hasText: 'Copied' });
  await expect(toast).toBeInViewport();
});

test('says why a batch has no tests', async ({ page }) => {
  const artifacts = '/mnt/qaboard/group/repo/ab/c123';
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/v1/tests/groups')
      return route.fulfill({ body: 'my-batch:\n  inputs: [a.jpg]\n', contentType: 'text/html' });
    if (url.pathname === '/api/v1/tests/group')
      return route.fulfill({ json: {
        tests: [],
        definitions: [],
        warnings: [
          `Not in this commit's artifacts (\`${artifacts}\`): \`qa/nightly.yaml\`. Check the names in \`inputs.batches\`, and run \`qa save-artifacts\` on this commit: it saves the files listed in \`inputs.batches\`.`,
          '`nightly` is not defined in the batch files QA-Board could read: `qa/batches.yaml`, `extra-batches.yml`, `alice.yml`.',
        ],
        files: [
          { source: 'commit', path: 'qa/batches.yaml', location: `${artifacts}/qa/batches.yaml`, status: 'ok', batches: 4 },
          { source: 'commit', path: 'qa/nightly.yaml', location: `${artifacts}/qa/nightly.yaml`, status: 'missing' },
          { source: 'qaboard', path: 'extra-batches.yml', location: '/shared/group/repo/extra-batches.yml', status: 'empty' },
          { source: 'qaboard', path: 'alice.yml', location: '/shared/group/repo/alice.yml', status: 'ok', batches: 1 },
        ],
      } });
    const key = Object.keys(api).sort((a, b) => b.length - a.length).find(k => url.pathname.startsWith(k));
    return route.fulfill({ json: key ? api[key] : {} });
  });
  await page.goto(`/${project}/commit/abc123?selected_views=groups`);
  await page.getByRole('button', { name: 'Check any batch or pattern…' }).click();
  const drawer = page.locator('.bp6-drawer');
  await drawer.getByLabel('Batch to check').fill('nightly');
  await drawer.getByRole('button', { name: 'Check' }).click();
  await expect(drawer.getByText('Why there are no tests')).toBeVisible();
  await expect(drawer.getByText('No batch matches')).toBeVisible();
  const files = drawer.getByRole('list', { name: 'Batch files' });
  await expect(files.getByText("not in the commit's artifacts")).toBeVisible();
  await expect(files.getByText(`${artifacts}/qa/nightly.yaml`)).toBeVisible();
});

test('the tuning form says where the batch is defined, and links to it', async ({ page }) => {
  const errors = [];
  page.on('console', msg => msg.type() === 'error' && errors.push(msg.text()));
  page.on('pageerror', error => errors.push(error.message));
  const config = { ...qatools_config, artifacts: { binaries: { glob: 'build/*' } } };
  const tuning_commit = { ...commit, data: { qatools_config: config } };
  const routes = {
    ...api,
    // the project's data
    '/api/v1/project': { qatools_config: config, git: { path_with_namespace: project, web_url: 'https://github.com/group/repo' } },
    '/api/v1/commit': tuning_commit,
    '/api/v1/commits': [tuning_commit],
  };
  // a batch split in many: the alias "nightly" stands for nightly-1, nightly-2...
  const definitions = [
    ...Array.from({ length: 8 }, (_, idx) => ({ name: `nightly-${idx + 1}`, files: ['qa/batches.yaml'], sources: ['commit'] })),
    { name: 'nightly-hdr', files: ['qa/batches.yaml', 'extra-batches.yml'], sources: ['commit', 'qaboard'] },
  ];
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/v1/tests/groups') {
      const name = url.searchParams.get('name');
      return route.fulfill({ body: name === 'extra-batches' ? '# shared\n\nnightly-hdr:\n  inputs: [images/HDR.jpg]\n' : '', contentType: 'text/html' });
    }
    if (url.pathname === '/api/v1/tests/group')
      return route.fulfill({ json: { tests: [{ input_path: 'images/A.jpg', configurations: ['base'] }], definitions, warnings: [], files: [] } });
    const key = Object.keys(routes).sort((a, b) => b.length - a.length).find(k => url.pathname.startsWith(k));
    return route.fulfill({ json: key ? routes[key] : {} });
  });

  await page.goto(`/${project}/commit/abc123?selected_views=tuning`);
  await page.getByLabel(/Batch of inputs/).fill('nightly');
  const defined = page.getByLabel('Where the batch is defined');
  // the files, not each of the batches
  await expect(defined).toHaveText(/^Defined in qa\/batches\.yaml and Shared batches/);
  await expect(defined).not.toContainText('nightly-1');
  await expect(defined.getByRole('link', { name: /qa\/batches\.yaml/ })).toHaveAttribute('href', 'https://github.com/group/repo/blob/abc123/qa/batches.yaml');
  await expect(defined).toContainText('the shared batches override nightly-hdr');

  await defined.getByRole('button', { name: /Shared batches/ }).click();
  await expect(page).toHaveURL(/selected_views=groups/);
  await expect(page.getByRole('tab', { name: /Shared/ })).toHaveAttribute('aria-selected', 'true');
  const editor = page.locator('.monaco-editor').first();
  await expect(editor.locator('.view-lines')).toContainText('nightly-hdr');
  // the cursor is on the batch
  await expect(editor.locator('.active-line-number')).toHaveText('3');
  expect(errors, 'errors in the browser console').toEqual([]);
});
