/**
 * The command palette: Ctrl+K or "/" opens it, users type, pick with the arrows and Enter, and go there.
 * Run with: cd webapp && npm test -- CommandPalette
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';

import { CommandPaletteProvider, PaletteButton, current_project } from '../CommandPalette';
import { ReleaseNotesProvider } from '../../releaseNotes/ReleaseNotes';
import { HelpSheetProvider } from '../../components/HelpSheet';
import { LAST_SEEN_KEY } from '../../releaseNotes/logic';
import { renderWithProviders } from '../../test-utils';
import { usePrefsStore } from '../../stores/prefs';


const alice = { is_logged: true, user_id: 1, user_name: 'alice', full_name: 'Alice', email: 'alice@example.com', is_admin: false };
const recent = new Date(Date.now() - 3600 * 1000).toISOString();
const projects = {
  'kitefin/k3': { data: {}, my_latest_activity: recent },
  'kitefin/k5': { data: {} },
  'hdr/tonemap': { data: {} },
};
const sha = 'abc123'.padEnd(40, 'f');
const my_batches = [{ id: 7, label: 'sweep', project: 'hdr/tonemap', origin: 'webapp', valid_outputs: 3, pending_outputs: 0, failed_outputs: 1, latest_output_datetime: recent, commit: { id: sha, branch: 'feature' } }];

const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const fetchMock = vi.fn(async url => {
  const { pathname, searchParams } = new URL(url, 'http://localhost');
  if (pathname === '/api/v1/projects') return json(projects);
  if (pathname === '/api/v1/batches') return json(my_batches);
  if (pathname === '/api/v1/project/branches') return json(['master', 'feature/denoise', 'denoise-v2'].filter(b => b.includes(searchParams.get('q'))));
  if (pathname === '/api/v1/commits') return json(searchParams.get('q') === 'id:abc1' ? [{ id: sha, message: 'Faster denoising\n\nDetails', branch: 'feature' }] : []);
  return json({});
});
const requests = path => fetchMock.mock.calls.map(([url]) => new URL(url, 'http://localhost')).filter(url => url.pathname === path);

const Location = () => {
  const { pathname, search } = useLocation();
  return <output data-testid="location">{pathname}{search}</output>;
};

const renderApp = (url = '/', { user = alice } = {}) => renderWithProviders(
  <MemoryRouter initialEntries={[url]}>
    <ReleaseNotesProvider load={() => Promise.resolve([])} popupDelay={0}>
      <HelpSheetProvider>
        <CommandPaletteProvider>
          <input aria-label="Some text box"/>
          <PaletteButton/>
          <Location/>
        </CommandPaletteProvider>
      </HelpSheetProvider>
    </ReleaseNotesProvider>
  </MemoryRouter>,
  { siteConfig: { docs_root: '/qa/' }, user },
);

const press = (key, extra = {}) => fireEvent.keyDown(document.activeElement ?? document.body, { key, ...extra });
// Blueprint's lists pick items on Enter's keyup
const enter = target => {
  fireEvent.keyDown(target, { key: 'Enter' });
  fireEvent.keyUp(target, { key: 'Enter' });
};
const location = () => screen.getByTestId('location').textContent;

describe('the command palette', () => {
  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
    localStorage.setItem(LAST_SEEN_KEY, '2099-12');
    usePrefsStore.setState({ favorites: { 'kitefin/k5': true }, theme: 'light' });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('opens with Ctrl+K, and goes to the project picked with the keyboard', async () => {
    renderApp();
    // nothing loads until it opens
    expect(requests('/api/v1/batches')).toHaveLength(0);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    press('k', { ctrlKey: true });
    const dialog = await screen.findByRole('dialog', { name: 'Search QA-Board' });
    const input = within(dialog).getByRole('combobox');
    expect(input).toHaveFocus();

    // pinned, then recently used projects, the user's batches, and pages
    const projects_group = await within(dialog).findByRole('group', { name: 'Projects' });
    expect(within(projects_group).getAllByRole('option').map(o => o.textContent)).toEqual(['kitefin/k5', 'kitefin/k3'].map(t => expect.stringContaining(t)));
    expect(await within(dialog).findByRole('group', { name: 'Your recent batches' })).toHaveTextContent('sweep');
    expect(requests('/api/v1/batches')[0].searchParams.get('scope')).toBe('mine');
    expect(requests('/api/v1/batches')[0].searchParams.get('limit')).toBe('8');

    fireEvent.change(input, { target: { value: 'k' } });
    await waitFor(() => expect(within(dialog).getAllByRole('option')[0]).toHaveTextContent('kitefin/k5'));
    // the first result is active
    expect(within(dialog).getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', within(dialog).getAllByRole('option')[0].id);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(within(dialog).getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
    enter(input);
    expect(location()).toBe('/kitefin/k3');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('opens with "/" and a button, but not while typing', async () => {
    renderApp();
    const box = screen.getByRole('textbox', { name: 'Some text box' });
    box.focus();
    fireEvent.keyDown(box, { key: '/' });
    fireEvent.keyDown(box, { key: 'k', ctrlKey: true });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    box.blur();
    press('/');
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    press('Escape');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('keeps what users type before the search box has the focus', async () => {
    renderApp();
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    fireEvent.keyDown(document.body, { key: 'k' });
    fireEvent.keyDown(document.body, { key: '5' });
    const input = await screen.findByRole('combobox');
    expect(input).toHaveValue('k5');
    expect(input).toHaveFocus();
    // Ctrl+K again closes it
    fireEvent.keyDown(input, { key: 'k', ctrlKey: true });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('stays open while Ctrl+K is held, and ignores keys composing text (IME)', async () => {
    renderApp();
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    const input = await screen.findByRole('combobox');
    fireEvent.keyDown(input, { key: 'k', ctrlKey: true, repeat: true });
    fireEvent.keyDown(input, { key: 'k', ctrlKey: true, repeat: true });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true, keyCode: 229 });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it("finds pages, and does actions", async () => {
    renderApp();
    press('k', { ctrlKey: true });
    const input = await screen.findByRole('combobox');
    fireEvent.change(input, { target: { value: 'tokens' } });
    await waitFor(() => expect(screen.getAllByRole('option')[0]).toHaveTextContent('Access tokens'));
    enter(input);
    expect(location()).toBe('/settings/tokens');

    press('k', { ctrlKey: true });
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'dark' } });
    await waitFor(() => expect(screen.getAllByRole('option')[0]).toHaveTextContent('Switch to the dark theme'));
    fireEvent.click(screen.getAllByRole('option')[0]);
    expect(usePrefsStore.getState().theme).toBe('dark');
  });

  it('says when nothing matches', async () => {
    renderApp();
    press('k', { ctrlKey: true });
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'zzzzqq' } });
    expect(await screen.findByText('No results for “zzzzqq”')).toBeInTheDocument();
    // screen readers hear it from a live region next to the list
    expect(await screen.findByText('0 results')).toBeInTheDocument();
  });

  it("finds the project's branches and commits, debounced", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderApp('/group/repo/commits');
      press('k', { ctrlKey: true });
      const input = await screen.findByRole('combobox');
      fireEvent.change(input, { target: { value: 'd' } });
      fireEvent.change(input, { target: { value: 'deno' } });
      await act(() => vi.advanceTimersByTimeAsync(250));
      const branches = await screen.findByRole('group', { name: /Branches/ });
      expect(within(branches).getAllByRole('option').map(o => o.textContent)).toEqual([expect.stringContaining('denoise-v2'), expect.stringContaining('feature/denoise')]);
      // only the last query was sent, bounded
      expect(requests('/api/v1/project/branches').map(url => url.searchParams.get('q'))).toEqual(['deno']);
      expect(requests('/api/v1/project/branches')[0].searchParams.get('limit')).toBe('8');

      // a hash: we look for the commit first
      fireEvent.change(input, { target: { value: 'abc1' } });
      await act(() => vi.advanceTimersByTimeAsync(250));
      const commits = await screen.findByRole('group', { name: 'Commits' });
      expect(within(commits).getByRole('option')).toHaveTextContent('Go to commit abc123ff');
      expect(within(commits).getByRole('option')).toHaveTextContent('Faster denoising');
      expect(requests('/api/v1/commits')[0].searchParams.get('project')).toBe('group/repo');
      enter(input);
      expect(location()).toBe(`/group/repo/commit/${sha}`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("doesn't look for branches outside of projects, nor batches for signed-out visitors", async () => {
    renderApp('/settings/profile', { user: { is_logged: false, user_id: null } });
    press('k', { ctrlKey: true });
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'sign' } });
    await waitFor(() => expect(screen.getAllByRole('option')[0]).toHaveTextContent('Sign in'));
    expect(requests('/api/v1/project/branches')).toHaveLength(0);
    expect(requests('/api/v1/batches')).toHaveLength(0);
  });
});

it('knows the current project', () => {
  expect(current_project('/')).toBeNull();
  expect(current_project('/settings/tokens')).toBeNull();
  expect(current_project('/projects')).toBeNull();
  expect(current_project('/group/repo/commit/abc')).toBe('group/repo');
  expect(current_project('/group/repo')).toBe('group/repo');
  expect(current_project('/admin/commits')).toBe('admin');
});
