/**
 * Tests for how many files each run lists in the Output Files view.
 * Run with: cd webapp && npm test -- bitAccuracyPreview
 */
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders as render } from '../../test-utils';

import BitAccuracyViewer from '../bit_accuracy/bitAccuracyViewer';
import { previewTree, countStates, PREVIEW_ROWS } from '../bit_accuracy/preview';


const file = (id, nodeData) => ({ id, label: id.split('/').pop(), nodeData: { checked: true, match: true, ...nodeData } });
const folder = (id, childNodes, nodeData = {}) => ({ id, label: id, childNodes, nodeData: { checked: true, ...nodeData } });
const ids = nodes => nodes.flatMap(n => [n.id, ...(n.childNodes && n.isExpanded ? ids(n.childNodes) : [])]);

describe('previewTree', () => {
  const is_expanded = node => !!node.isExpanded;

  it('keeps small trees, and does not hide a single row', () => {
    const nodes = Array.from({ length: PREVIEW_ROWS + 1 }, (_, i) => file(`f${i}`, { differs: true }));
    expect(previewTree(nodes, { is_expanded }).nodes).toBe(nodes);
    expect(previewTree(nodes, { is_expanded }).hidden_files).toEqual([]);
  });

  it('shows the differences first, in tree order, and the files it hides', () => {
    const nodes = [
      ...['a', 'b', 'c', 'd', 'e', 'f'].map(id => file(id, { differs: false })),
      file('x', { differs: true, match: false }),
      file('y', { differs: true, match: false, checked: false }),
    ];
    const { nodes: shown, hidden_files } = previewTree(nodes, { is_expanded, max_rows: 3 });
    expect(shown.map(n => n.id)).toEqual(['a', 'x', 'y']);
    expect(hidden_files.map(n => n.id)).toEqual(['b', 'c', 'd', 'e', 'f']);
  });

  it('keeps the parents of the rows it shows, and collapsed folders whole', () => {
    const nodes = [
      { ...folder('open', [file('open/1', { differs: true }), file('open/2', { differs: true }), file('open/3', { differs: true })], { differs: true }), isExpanded: true },
      folder('closed', [file('closed/1', { differs: true }), file('closed/2', { differs: true })], { differs: true }),
      file('z', { differs: true }),
    ];
    const { nodes: shown, hidden_files } = previewTree(nodes, { is_expanded, max_rows: 3 });
    expect(ids(shown)).toEqual(['open', 'open/1', 'closed']);
    expect(hidden_files.map(n => n.id)).toEqual(['open/2', 'open/3', 'z']);
  });

  it('prefers folders: their row tells about more files', () => {
    const nodes = [file('a', { differs: true }), file('b', { differs: true }), folder('c', [file('c/1', { differs: true })], { differs: true })];
    expect(previewTree(nodes, { is_expanded, max_rows: 1 }).nodes.map(n => n.id)).toEqual(['c']);
  });
});

describe('countStates', () => {
  it('counts the files by how they compare with the reference', () => {
    const files = [
      file('a', { match: false }), file('b', { match: false }),
      file('c', { missing_from_reference: true }), file('d', { missing_from_new: true }),
      file('e'), file('f', { checked: false }),
    ];
    expect(countStates(files, true).map(({ state, count }) => [state, count])).toEqual([
      ['different', 2], ['added', 1], ['removed', 1], ['same', 1], ['not_checked', 1],
    ]);
    // without a reference, only what isn't checked
    expect(countStates(files, false).map(({ state }) => state)).toEqual(['not_checked']);
  });
});


// a run with 20 files that differ from the reference
const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`file${String(i).padStart(2, '0')}.txt`, { md5: `new${i}`, st_size: 1 }]));
const many_ref = Object.fromEntries(Object.keys(many).map(path => [path, { md5: 'ref', st_size: 1 }]));
const manifests = { new: { ...many, 'dir/a.txt': { md5: 'x' } }, reference: { ...many_ref, 'dir/a.txt': { md5: 'y' } } };
const output_new = { id: 1, output_dir_url: '/s/new', metrics: {} };
const output_ref = { id: 2, output_dir_url: '/s/ref', metrics: {} };
const props = { manifests, output_new, output_ref };
// the rows the preview hides are on the page, hidden, for the browser's search
const shown = text => screen.queryByText(text, { ignore: 'script, style, [data-testid="hidden-files"] *' });

describe('BitAccuracyViewer, with many files', () => {
  it('lists the first files, says what the others are, and shows them all on click', () => {
    render(<BitAccuracyViewer {...props}/>);
    expect(screen.getByText('dir')).toBeInTheDocument();
    expect(screen.getByText('file03.txt')).toBeInTheDocument();
    expect(shown('file04.txt')).not.toBeInTheDocument();
    expect(screen.getByText('16 different')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /16 more files/ }));
    expect(screen.getByText('file19.txt')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Show fewer files/ }));
    expect(shown('file19.txt')).not.toBeInTheDocument();
  });

  it('lists every file when users ask for more: a filter, expanded folders, a folder they open', () => {
    const { rerender, container } = render(<BitAccuracyViewer {...props} files_filter="file"/>);
    expect(screen.getByText('file19.txt')).toBeInTheDocument();
    rerender(<BitAccuracyViewer {...props} expand_all/>);
    expect(screen.getByText('file19.txt')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /more files|Show fewer/ })).not.toBeInTheDocument();
    rerender(<BitAccuracyViewer {...props}/>);
    expect(shown('file19.txt')).not.toBeInTheDocument();
    fireEvent.click(container.querySelector('.bp6-tree-node-caret'));
    expect(screen.getByText('a.txt')).toBeInTheDocument();
    expect(screen.getByText('file19.txt')).toBeInTheDocument();
  });

  it('with "Collapse runs", says only what the files are', () => {
    render(<BitAccuracyViewer {...props} collapse_runs/>);
    expect(screen.queryByText('dir')).not.toBeInTheDocument();
    expect(screen.getByText('21 different')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /21 files/ }));
    expect(screen.getByText('file19.txt')).toBeInTheDocument();
  });
});

describe('BitAccuracyViewer, and the browser search', () => {
  it("keeps the hidden rows on the page, where Ctrl+F finds them and shows the run's files", () => {
    render(<BitAccuracyViewer {...props}/>);
    const hidden = screen.getByTestId('hidden-files');
    expect(hidden).toHaveAttribute('hidden', 'until-found');
    expect(hidden).toHaveTextContent('file19.txt');
    // what browsers do before they scroll to a match
    fireEvent(hidden, new Event('beforematch'));
    expect(screen.getByText('file19.txt')).toBeVisible();
    expect(screen.queryByTestId('hidden-files')).not.toBeInTheDocument();
  });
});
