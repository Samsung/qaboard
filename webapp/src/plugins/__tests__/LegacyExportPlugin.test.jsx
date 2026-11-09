/**
 * The previous export, kept while people move to the new one (ExportPlugin): the same form and API as before.
 * Run with: cd webapp && npm test -- LegacyExportPlugin
 */
import { screen, fireEvent, waitFor } from '@testing-library/react';

import { LegacyExportPlugin } from '../LegacyExportPlugin';
import { renderWithProviders } from '../../test-utils';

vi.mock('copy-to-clipboard', () => ({ default: vi.fn() }));

const json = (data, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));

describe('LegacyExportPlugin', () => {
  afterEach(() => vi.restoreAllMocks());

  it('exports the files of the first visualization', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => json({ export_dir: '/exports/x', nb_files_exported: 3, nb_outputs: 2, errors: [] }));
    renderWithProviders(<LegacyExportPlugin
      project="p" new_commit_id="abc" selected_batch_new="default"
      config={{ outputs: { visualizations: [{ path: 'debug/:frame/out.png' }] } }}
    />);
    // the form is behind a button
    expect(screen.queryByDisplayValue('debug/*/out.png')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Export files (legacy)' }));
    expect(await screen.findByDisplayValue('debug/*/out.png')).toBeInTheDocument();
    // it says it's going away
    expect(screen.getByText(/This is the previous export/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(await screen.findByText(/3 files exported from 2 runs/)).toBeInTheDocument();
    const url = new URL(fetch.mock.calls[0][0], 'http://localhost');
    expect(url.pathname).toBe('/api/v1/export/');
    // it writes files: not a GET, that other websites' links could send
    expect(fetch.mock.calls[0][1].method).toBe('POST');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ path: 'debug/*/out.png', project: 'p', new_commit_id: 'abc', export_type: 'link' });
    expect(url.searchParams.has('export_dir')).toBe(false);
  });

  it('keeps the form and the last export when it closes', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => json({ export_dir: '/exports/x', nb_files_exported: 3, nb_outputs: 2, errors: [] }));
    renderWithProviders(<LegacyExportPlugin project="p" new_commit_id="abc" selected_batch_new="default" config={{}}/>);
    const toggle = screen.getByRole('button', { name: 'Export files (legacy)' });
    fireEvent.click(toggle);
    const input = await screen.findByLabelText(/Files to export/);
    expect(input).toHaveValue('*.png');
    fireEvent.change(input, { target: { value: '*.txt' } });
    // Enter exports too
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByText('/exports/x')).toBeInTheDocument();
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.queryByDisplayValue('*.txt')).not.toBeInTheDocument());
    fireEvent.click(toggle);
    expect(await screen.findByDisplayValue('*.txt')).toBeInTheDocument();
    expect(screen.getByText('/exports/x')).toBeInTheDocument();
  });
});
