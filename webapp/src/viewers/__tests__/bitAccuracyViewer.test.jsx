/**
 * Tests for the bit-accuracy viewer: comparing the files of two outputs.
 * Run with: cd webapp && npm test -- bitAccuracyViewer
 */
import { render, screen, fireEvent } from '@testing-library/react';

import BitAccuracyViewer from '../bit_accuracy/bitAccuracyViewer';


const manifests = {
  new: {
    'same.txt': { md5: 'a', st_size: 1 },
    'dir/changed.txt': { md5: 'b', st_size: 2 },
    'dir/added.txt': { md5: 'c', st_size: 3 },
  },
  reference: {
    'same.txt': { md5: 'a', st_size: 1 },
    'dir/changed.txt': { md5: 'B', st_size: 2 },
    'removed.txt': { md5: 'd', st_size: 4 },
  },
};
const output_new = { id: 1, output_dir_url: '/s/new', metrics: {} };
const output_ref = { id: 2, output_dir_url: '/s/ref', metrics: {} };

const deep_freeze = o => {
  Object.values(o).forEach(v => typeof v === 'object' && v !== null && deep_freeze(v));
  return Object.freeze(o);
};


describe('BitAccuracyViewer', () => {
  it('shows only the files that differ, without mutating the manifests', () => {
    render(<BitAccuracyViewer manifests={deep_freeze(structuredClone(manifests))} output_new={output_new} output_ref={output_ref} />);
    expect(screen.getByText('dir')).toBeInTheDocument();
    expect(screen.getByText('removed.txt')).toBeInTheDocument();
    expect(screen.queryByText('same.txt')).not.toBeInTheDocument();
    // folders are collapsed
    expect(screen.queryByText('changed.txt')).not.toBeInTheDocument();
    expect(screen.queryByText('Bit-accurate')).not.toBeInTheDocument();
  });

  it('expands folders', () => {
    const { container } = render(<BitAccuracyViewer manifests={manifests} output_new={output_new} output_ref={output_ref} />);
    fireEvent.click(container.querySelector('.bp6-tree-node-caret'));
    expect(screen.getByText('changed.txt')).toBeInTheDocument();
    expect(screen.getByText('added.txt')).toBeInTheDocument();
  });

  it('can show all files, expanded', () => {
    render(<BitAccuracyViewer manifests={manifests} output_new={output_new} output_ref={output_ref} show_all_files expand_all />);
    expect(screen.getByText('same.txt')).toBeInTheDocument();
    expect(screen.getByText('changed.txt')).toBeInTheDocument();
  });

  it('filters files', () => {
    render(<BitAccuracyViewer manifests={manifests} output_new={output_new} output_ref={output_ref} files_filter="added" />);
    expect(screen.getByText('added.txt')).toBeInTheDocument();
    expect(screen.queryByText('changed.txt')).not.toBeInTheDocument();
  });

  it('tells when outputs are bit-accurate', () => {
    render(<BitAccuracyViewer manifests={{ new: manifests.reference, reference: manifests.reference }} output_new={output_new} output_ref={output_ref} show_all_files />);
    expect(screen.getByText('Bit-accurate')).toBeInTheDocument();
  });
});
