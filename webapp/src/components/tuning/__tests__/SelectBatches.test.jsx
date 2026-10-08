/**
 * Tests for the batch selector of the commit navbar.
 * Run with: cd webapp && npm test -- SelectBatches
 */
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { act } from 'react';

import { SelectBatchesNav } from '../SelectBatches';


const make_commit = () => ({
  id: 'abc123',
  batches: Object.fromEntries(
    ['default', ...Array.from({length: 30}, (_, i) => `batch-${String(i).padStart(2, '0')}`)].map(label => [label, {
      label,
      data: {commands: {c: {user: 'alice'}}},
      outputs: {1: {output_type: 'slam', is_pending: false, is_failed: false}},
    }]),
  ),
});

const renderNav = (props = {}) => {
  const all = {commit: make_commit(), batch: {label: 'batch-05'}, project: 'p', project_data: {}, onChange: () => {}, ...props};
  const utils = render(<SelectBatchesNav {...all} />);
  return {...utils, rerenderNav: more => utils.rerender(<SelectBatchesNav {...all} {...more} />)};
};

const open = () => fireEvent.click(screen.getByRole('button'));
const listbox = () => screen.getByRole('listbox');
const activeLabel = () => listbox().querySelector('.bp6-active')?.textContent;


describe('SelectBatchesNav', () => {
  it('lists the batches, CI first', () => {
    renderNav();
    open();
    const items = within(listbox()).getAllByRole('option');
    expect(items).toHaveLength(31);
    expect(items[0].textContent).toContain('CI');
  });

  it('keeps the scroll position when the parent re-renders', async () => {
    // jsdom has no layout: fake 30px-high items in a 300px-high menu, so that Blueprint can scroll them into view
    const height = 30;
    const spies = [
      vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function () {
        const li = this.closest('li');
        return li ? [...li.parentElement.children].indexOf(li) * height : 0;
      }),
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(() => height),
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => 10 * height),
    ];
    const { rerenderNav } = renderNav();
    open();
    listbox().style.padding = '0px';
    await act(() => new Promise(r => requestAnimationFrame(r)));
    listbox().scrollTop = 500;
    // the navbar re-renders, and the commit was re-fetched, with the same content
    await act(async () => rerenderNav({filter: 'something', commit: make_commit()}));
    await act(() => new Promise(r => requestAnimationFrame(r)));
    expect(listbox().scrollTop).toBe(500);
    spies.forEach(s => s.mockRestore());
  });

  it('starts on the selected batch and keeps the active item across re-renders', async () => {
    const { rerenderNav } = renderNav();
    open();
    expect(activeLabel()).toContain('batch-05');
    fireEvent.keyDown(screen.getByRole('combobox'), {key: 'ArrowDown'});
    expect(activeLabel()).toContain('batch-06');
    await act(async () => rerenderNav({filter: 'something', commit: make_commit()}));
    expect(activeLabel()).toContain('batch-06');
  });

  it('shows updates to the batches', async () => {
    const { rerenderNav } = renderNav();
    expect(screen.getByRole('button').textContent).toContain('1/1 ✅');
    const commit = make_commit();
    commit.batches['batch-05'].outputs[2] = {output_type: 'slam', is_failed: true};
    await act(async () => rerenderNav({commit, project_data: {data: {milestones: {'p/abc123/batch-05': {}}}}}));
    expect(screen.getByRole('button').textContent).toContain('⭐ batch-05');
    expect(screen.getByRole('button').textContent).toContain('1/2 ✅ 1❌');
  });

  it('re-opens on the selected batch', async () => {
    renderNav();
    open();
    fireEvent.keyDown(screen.getByRole('combobox'), {key: 'ArrowDown'});
    expect(activeLabel()).toContain('batch-06');
    fireEvent.keyDown(screen.getByRole('combobox'), {key: 'Escape'});
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    open();
    expect(activeLabel()).toContain('batch-05');
  });

  it('selects a batch on click', () => {
    const onChange = vi.fn();
    renderNav({onChange});
    open();
    fireEvent.click(screen.getByText('batch-10'));
    expect(onChange).toHaveBeenCalledWith({target: {value: 'batch-10'}});
  });

  it('filters by user and status', () => {
    renderNav();
    open();
    fireEvent.change(screen.getByRole('combobox'), {target: {value: 'batch-2'}});
    expect(within(listbox()).getAllByRole('option')).toHaveLength(10);
  });
});
