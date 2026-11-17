/**
 * The parallel coordinates plot, without canvas (jsdom has none): the axes, filters and menus.
 * Run with: cd webapp && npm test -- parallel
 */
import { fireEvent, render, screen, within } from '@testing-library/react';

import { ParallelCoordinates } from '../ParallelCoordinates';
import { generate } from '../generate';

const columns = [
  { key: 'psnr', label: 'PSNR', suffix: ' dB', better: 'higher', group: 'Metrics' },
  { key: 'strength', label: 'denoise.strength', group: 'Parameters' },
  { key: 'mode', label: 'mode', group: 'Parameters' },
  { key: 'bits', label: 'bit depth', group: 'Parameters' },
];
const rows = [
  { id: 'a', label: 'Experiment 1', values: { psnr: 30.5, strength: 0.1, mode: 'fast', bits: 10 } },
  { id: 'b', label: 'Experiment 2', values: { psnr: 32.25, strength: 0.5, mode: 'fast', bits: 10 } },
  { id: 'c', label: 'Experiment 3', values: { psnr: 31, strength: 0.5, mode: 'accurate', bits: 10 } },
  { id: 'd', label: 'Experiment 4', values: { psnr: NaN, strength: 0.9, mode: 'accurate', bits: 10 } },
];
const titles = () => screen.getAllByRole('button', { name: /: options$/ }).map(b => b.getAttribute('aria-label').replace(': options', ''));

describe('ParallelCoordinates', () => {
  it('shows an axis per column that varies, and hides the constant ones', () => {
    render(<ParallelCoordinates columns={columns} rows={rows} colorBy="psnr" marks={{ b: { label: 'Best' } }}/>);
    expect(screen.getByRole('figure')).toHaveAccessibleName('Parallel coordinates: 4 rows, 3 columns (PSNR, denoise.strength, mode), colored by PSNR');
    expect(titles()).toEqual(['PSNR', 'denoise.strength', 'mode']);
    expect(screen.getByText('Metrics')).toBeInTheDocument();
    expect(screen.getByText('Parameters')).toBeInTheDocument();
    // categories with how many rows they have, the values of a grid, the range's ends, and the rows without a value
    expect(screen.getByRole('button', { name: /fast\s*2/ })).toHaveAttribute('title', expect.stringContaining('2 rows'));
    expect(screen.getByRole('button', { name: '0.5' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '32.25' })).toHaveAttribute('title', expect.stringContaining('32.25 dB'));
    expect(screen.getByText('missing')).toBeInTheDocument();
    expect(screen.getByTitle('Higher is better')).toBeInTheDocument();
    expect(screen.getByText('4 rows')).toBeInTheDocument();
    // the legend, with the true range
    expect(screen.getByLabelText('Color scale of PSNR')).toHaveTextContent('30.5 dB32.25 dBbetter');
    expect(screen.getByRole('button', { name: '+ 1 hidden' })).toBeInTheDocument();
  });

  it('brings back hidden columns, with their constant value', async () => {
    render(<ParallelCoordinates columns={columns} rows={rows}/>);
    fireEvent.click(screen.getByRole('button', { name: '+ 1 hidden' }));
    const item = await screen.findByRole('menuitem', { name: /bit depth/ });
    expect(item).toHaveTextContent('= 10');
    fireEvent.click(item);
    expect(titles()).toEqual(['PSNR', 'denoise.strength', 'mode', 'bit depth']);
    expect(screen.queryByRole('button', { name: /hidden$/ })).not.toBeInTheDocument();
  });

  it('filters by clicking categories and values, and reports the rows that pass', () => {
    const onSelectionChange = vi.fn();
    render(<ParallelCoordinates columns={columns} rows={rows} onSelectionChange={onSelectionChange}/>);
    expect(onSelectionChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /accurate\s*2/ }));
    expect(onSelectionChange).toHaveBeenLastCalledWith(['c', 'd']);
    expect(screen.getByText('2', { selector: 'strong' }).parentElement).toHaveTextContent('2 of 4 shown');
    expect(screen.getByRole('button', { name: /accurate\s*2/ })).toHaveAttribute('aria-pressed', 'true');
    // with another axis: both
    fireEvent.click(screen.getByRole('button', { name: '0.5' }));
    expect(onSelectionChange).toHaveBeenLastCalledWith(['c']);
    // the rows without a value can be picked too
    fireEvent.click(screen.getByRole('button', { name: '0.5' }));
    fireEvent.click(screen.getByTitle(/1 without a value/));
    expect(onSelectionChange).toHaveBeenLastCalledWith(['d']);
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(onSelectionChange).toHaveBeenLastCalledWith(null);
    expect(screen.getByText('4 rows')).toBeInTheDocument();
  });

  it('offers a menu per axis: color, flip, log scale, move, hide', async () => {
    const onColorByChange = vi.fn();
    render(<ParallelCoordinates columns={columns} rows={rows} colorBy={null} onColorByChange={onColorByChange}/>);
    fireEvent.click(screen.getByRole('button', { name: 'denoise.strength: options' }));
    const menu = (await screen.findByRole('menuitem', { name: /Color by this/ })).closest('ul');
    expect(within(menu).getAllByRole('menuitem').map(i => i.textContent)).toEqual(['Color by this', 'Flip direction', 'Log scale', 'Move left', 'Move right', 'Hide']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Color by this/ }));
    expect(onColorByChange).toHaveBeenCalledWith('strength');

    fireEvent.click(screen.getByRole('button', { name: 'denoise.strength: options' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Move left/ }));
    expect(titles()).toEqual(['denoise.strength', 'PSNR', 'mode']);
    fireEvent.click(await screen.findByRole('menuitem', { name: /Log scale/ }));
    expect(screen.getByRole('button', { name: 'denoise.strength: options' })).toHaveTextContent('log');
    fireEvent.click(await screen.findByRole('menuitem', { name: /Hide/ }));
    expect(titles()).toEqual(['PSNR', 'mode']);
    expect(screen.getByRole('button', { name: '+ 2 hidden' })).toBeInTheDocument();
  });

  it('colors by its own choice without onColorByChange', async () => {
    render(<ParallelCoordinates columns={columns} rows={rows} colorBy="psnr"/>);
    fireEvent.click(screen.getByTitle('Choose the column that colors the lines'));
    fireEvent.click(within(await screen.findByRole('option', { name: /mode/ })).getByText('mode'));
    expect(screen.getByRole('figure')).toHaveAccessibleName(expect.stringContaining('colored by mode'));
    expect(screen.getByTitle('fast: 2 rows')).toBeInTheDocument();
  });

  it('says when there is nothing to compare', () => {
    const { rerender } = render(<ParallelCoordinates columns={columns} rows={[]}/>);
    expect(screen.getByText('Nothing to compare yet')).toBeInTheDocument();
    expect(screen.getByText('There are no rows.')).toBeInTheDocument();
    rerender(<ParallelCoordinates columns={columns} rows={rows.slice(0, 1)}/>);
    expect(screen.getByText(/only one row/)).toBeInTheDocument();
    rerender(<ParallelCoordinates columns={columns.slice(2)} rows={rows}/>);
    expect(screen.getByText(/at least two columns/)).toBeInTheDocument();
    rerender(<ParallelCoordinates columns={columns} rows={[]} empty="No experiment finished yet"/>);
    expect(screen.getByText('No experiment finished yet')).toBeInTheDocument();
  });

  it('renders thousands of rows and dozens of columns', () => {
    const data = generate({ kind: 'mixed', rows: 2000, columns: 45 });
    render(<ParallelCoordinates {...data}/>);
    expect(titles().length).toBe(43);
    expect(screen.getByText('2,000 rows')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ 2 hidden' })).toBeInTheDocument();
  });
});
