import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { fnmatchRegExp, bitAccuracyChecker, markChecked, bitAccuracySummary } from '../checked';
import BitAccuracyViewer from '../bitAccuracyViewer';

// the diffs below the tree aren't tested here
vi.mock('../../OutputViewer', () => ({ OutputViewer: () => null }));


describe('fnmatchRegExp', () => {
  // like Python's fnmatch.fnmatch
  const fnmatch = (path, pattern) => fnmatchRegExp(pattern).test(path);

  it('matches like Python fnmatch', () => {
    expect(fnmatch('stages/4.png', '*stages/*.png')).toBe(true);
    expect(fnmatch('a/stages/4.png', '*stages/*.png')).toBe(true);
    // * matches "/" too
    expect(fnmatch('stages/deep/4.png', '*stages/*.png')).toBe(true);
    expect(fnmatch('stages/4.jpg', '*stages/*.png')).toBe(false);
    expect(fnmatch('out.png', '*out?png')).toBe(true);
    expect(fnmatch('raw/1.u16', '*raw/[0-9].u16')).toBe(true);
    expect(fnmatch('raw/a.u16', '*raw/[!0-9].u16')).toBe(true);
    expect(fnmatch('raw/1.u16', '*raw/[!0-9].u16')).toBe(false);
    // regexp characters are literal
    expect(fnmatch('outXpng', '*out.png')).toBe(false);
    expect(fnmatch('a+b(1).txt', 'a+b(1).txt')).toBe(true);
    // an unclosed [ is literal
    expect(fnmatch('[a', '[a')).toBe(true);
    // ] first in a set is literal
    expect(fnmatch(']', '[]]')).toBe(true);
    expect(fnmatch('a', '[!]]')).toBe(true);
    // the whole path must match, case-sensitive
    expect(fnmatch('out.png.bak', '*out.png')).toBe(false);
    expect(fnmatch('OUT.png', '*out.png')).toBe(false);
  });

  it("doesn't throw on patterns that aren't valid regexps", () => {
    expect(fnmatchRegExp('[z-a]').test('b')).toBe(false);
  });
});


describe('bitAccuracyChecker', () => {
  it('checks all files but the ones that change at each run by default', () => {
    const checked = bitAccuracyChecker(undefined);
    expect(checked('out.png')).toBe(true);
    expect(checked('stages/4.png')).toBe(true);
    for (const file of ['metrics.json', 'run.json', 'log.txt', 'log.lsf.txt', 'manifest.inputs.json', '.nfs0001234'])
      expect(checked(file)).toBe(false);
    expect(bitAccuracyChecker({ patterns: [] })('out.png')).toBe(true);
    expect(bitAccuracyChecker({ patterns: null })('out.png')).toBe(true);
  });

  it('checks only the files matching the patterns, anywhere in the run', () => {
    // examples/image-quality/qaboard.yaml
    const checked = bitAccuracyChecker({ patterns: ['out.png', 'stages/*.png', 'raw/*.u16', 'regs.txt'], plaintext: ['*.txt'] });
    expect(checked('out.png')).toBe(true);
    expect(checked('stages/4.png')).toBe(true);
    expect(checked('raw/4.u16')).toBe(true);
    expect(checked('regs.txt')).toBe(true);
    expect(checked('debug/out.png')).toBe(true);
    expect(checked('stages/4.jpg')).toBe(false);
    expect(checked('timings.txt')).toBe(false);
    expect(checked('metrics.json')).toBe(false);
  });

  it('accepts a single pattern', () => {
    const checked = bitAccuracyChecker({ patterns: '*.png' });
    expect(checked('out.png')).toBe(true);
    expect(checked('regs.txt')).toBe(false);
  });

  it('ignores the paths starting with bit_accuracy.ignore', () => {
    const checked = bitAccuracyChecker({ ignore: ['debug', 'tmp*.png'] });
    expect(checked('debug/out.png')).toBe(false);
    expect(checked('debug.txt')).toBe(false);
    expect(checked('tmp-1.png')).toBe(false);
    expect(checked('stages/debug/out.png')).toBe(true);
    expect(checked('out.png')).toBe(true);
    expect(bitAccuracyChecker({ ignore: 'debug' })('debug/out.png')).toBe(false);
  });
});


const file = (id, nodeData) => ({ id, label: id.split('/').pop(), nodeData: { match: true, ...nodeData } });
const folder = (id, childNodes) => ({ id, label: id.split('/').pop(), childNodes, nodeData: { match: true } });

describe('markChecked and bitAccuracySummary', () => {
  const checked = bitAccuracyChecker({ patterns: ['out.png', 'stages/*.png'] });

  it('ignores the differences in the files that are not checked', () => {
    const tree = markChecked([
      file('out.png'),
      file('metrics.json', { match: false }),
      folder('stages', [file('stages/1.png'), file('stages/1.jpg', { match: false })]),
      folder('debug', [file('debug/extra.txt', { missing_from_reference: true })]),
    ], checked);
    expect(bitAccuracySummary(tree)).toEqual({ checked: 2, bit_accurate: true });
    const [, metrics, stages, debug] = tree;
    expect(metrics.nodeData).toMatchObject({ checked: false, differs: true });
    // folders summarize their checked files, and say whether any of their files differ
    expect(stages.nodeData).toMatchObject({ checked: true, match: true, differs: true });
    expect(debug.nodeData).toMatchObject({ checked: false, missing_from_reference: false, differs: true });
  });

  it('is not bit-accurate if a checked file differs, or is only in one run', () => {
    const different = markChecked([file('out.png'), folder('stages', [file('stages/1.png', { match: false })])], checked);
    expect(bitAccuracySummary(different).bit_accurate).toBe(false);
    expect(different[1].nodeData).toMatchObject({ checked: true, match: false, differs: true });
    const added = markChecked([file('out.png'), folder('stages', [file('stages/2.png', { missing_from_reference: true })])], checked);
    expect(bitAccuracySummary(added).bit_accurate).toBe(false);
    expect(added[1].nodeData.missing_from_reference).toBe(true);
    const removed = markChecked([file('out.png'), file('stages/2.png', { missing_from_new: true })], checked);
    expect(bitAccuracySummary(removed).bit_accurate).toBe(false);
  });

  it('is not bit-accurate if no file is checked', () => {
    const tree = markChecked([file('metrics.json'), file('notes.txt')], checked);
    expect(bitAccuracySummary(tree)).toEqual({ checked: 0, bit_accurate: false });
  });
});


describe('BitAccuracyViewer', () => {
  const manifest = ({ out = 'a', metrics = 'm1', regs = 'r' } = {}) => ({
    'out.png': { md5: out, st_size: 10 },
    'metrics.json': { md5: metrics, st_size: 10 },
    'run.json': { md5: metrics, st_size: 10 },
    'regs.txt': { md5: regs, st_size: 10 },
  });
  const config = { bit_accuracy: { patterns: ['out.png', 'regs.txt'] } };
  const output = { output_dir_url: '/s/run' };
  const show = (manifests, props = {}) => render(<BitAccuracyViewer
    manifests={manifests} config={config} output_new={output} output_ref={output} {...props}
  />);

  it("says the run is bit-accurate when only files that aren't checked differ, and greys them", () => {
    const { container } = show({ new: manifest(), reference: manifest({ metrics: 'm2' }) });
    expect(screen.getByText('Bit-accurate')).toBeInTheDocument();
    // the files that differ are still listed
    expect(screen.getByText('metrics.json')).toBeInTheDocument();
    expect(screen.getByText('run.json')).toBeInTheDocument();
    expect(screen.queryByText('out.png')).not.toBeInTheDocument();
    expect(screen.getAllByText('not checked')).toHaveLength(2);
    expect(container.querySelectorAll('.bp6-tree-node.bp6-text-muted')).toHaveLength(2);
  });

  it('lists the checked files that differ', () => {
    show({ new: manifest({ regs: 'r2' }), reference: manifest({ metrics: 'm2' }) });
    expect(screen.queryByText('Bit-accurate')).not.toBeInTheDocument();
    expect(screen.getByText('regs.txt')).toBeInTheDocument();
    expect(screen.getAllByText('not checked')).toHaveLength(2);
  });

  it('checks all files but metrics, logs... without bit_accuracy.patterns', () => {
    show({ new: manifest(), reference: manifest({ metrics: 'm2' }) }, { config: {} });
    expect(screen.getByText('Bit-accurate')).toBeInTheDocument();
    show({ new: { ...manifest(), 'notes.txt': { md5: 'x' } }, reference: { ...manifest(), 'notes.txt': { md5: 'y' } } }, { config: {} });
    expect(screen.getAllByText('Bit-accurate')).toHaveLength(1);
  });

  it("doesn't say a run is bit-accurate without a reference", () => {
    show({ new: manifest() });
    expect(screen.queryByText('Bit-accurate')).not.toBeInTheDocument();
  });
});
