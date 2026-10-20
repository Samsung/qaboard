import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { CompareWithMenu, groupCandidates, matchCandidates } from '../compareWith';

const candidates = [
  { id: 'gt/0001.png', image: { iiif: '/iiif/2/gt%2F0001.png' }, label: 'gt/0001.png', group: 'Suggested', detail: 'Same name, in gt/' },
  { id: 'input.png', image: '/input.png', label: 'input.png', group: 'This run' },
  { id: 'debug/edges.png', image: '/debug/edges.png', group: 'This run' },
];

describe('compare with', () => {
  it('finds images by all the words of the query, in any order', () => {
    expect(matchCandidates(candidates, '').map(c => c.id)).toHaveLength(3);
    expect(matchCandidates(candidates, 'GT 0001').map(c => c.id)).toEqual(['gt/0001.png']);
    expect(matchCandidates(candidates, '0001 same').map(c => c.id)).toEqual(['gt/0001.png']);
    // without a label, the id
    expect(matchCandidates(candidates, 'edges').map(c => c.id)).toEqual(['debug/edges.png']);
    expect(matchCandidates(candidates, 'nothing')).toEqual([]);
  });

  it('groups them in the order the groups appear', () => {
    expect(groupCandidates(candidates).map(({ group, items }) => [group, items.length])).toEqual([['Suggested', 1], ['This run', 2]]);
  });

  const menu = (props = {}) => {
    const onSelect = vi.fn();
    const close = vi.fn();
    render(<CompareWithMenu reference="/ref.png" referenceName="reference" candidates={candidates} selected={null} onSelect={onSelect} close={close} {...props} />);
    return { onSelect, close };
  };

  it('lists the reference first, then the images by group', () => {
    menu();
    const options = screen.getAllByRole('option');
    expect(options.map(option => option.textContent)).toEqual([
      expect.stringContaining('reference'),
      expect.stringContaining('gt/0001.png'),
      expect.stringContaining('input.png'),
      expect.stringContaining('debug/edges.png'),
    ]);
    expect(options[0].getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('Suggested')).toBeTruthy();
  });

  it('picks with the arrows and Enter, or a click', () => {
    const { onSelect, close } = menu();
    const search = screen.getByRole('searchbox');
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onSelect).toHaveBeenLastCalledWith('gt/0001.png');
    expect(close).toHaveBeenCalled();
    fireEvent.click(screen.getByTitle('Compare with the reference'));
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it('filters as users type, and says when nothing matches', () => {
    const { onSelect } = menu({ selected: 'input.png' });
    const search = screen.getByRole('searchbox');
    fireEvent.change(search, { target: { value: 'edges' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onSelect).toHaveBeenLastCalledWith('debug/edges.png');
    fireEvent.change(search, { target: { value: 'nothing' } });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText(/No image matches/)).toBeTruthy();
  });

  it('works without a reference', () => {
    menu({ reference: null });
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });
});
