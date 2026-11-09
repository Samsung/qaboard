/**
 * Runs' names: after their batch and database when the runs shown come from several, and what hovering them shows.
 * Run with: cd webapp && npm test -- runNames
 */
import { act, fireEvent, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { renderWithProviders } from '../../test-utils';

import { usePrefsStore } from '../../stores/prefs';
import { RunName, RunOriginsContext, databaseLabels, runNameShown, runOriginParts, runOrigins, runLabel } from '../runNames';


const run = (batch, database, path, extra) => ({
  id: 1,
  output_type: 'slam',
  data: { batch },
  test_input_database: database,
  test_input_path: path,
  test_input_metadata: {},
  ...extra,
});

const origins_of = outputs => {
  const origins = runOrigins(outputs);
  return { ...origins, database_labels: databaseLabels(origins.databases) };
};

afterEach(() => act(() => usePrefsStore.setState({ runNameOrigin: 'auto' })));


describe('databaseLabels', () => {
  it('keeps the shortest ends of the paths that tell databases apart', () => {
    const labels = databaseLabels(['/data/a/images', '/data/b/images', '/data/kitti/', '/']);
    expect(labels.get('/data/a/images')).toBe('a/images');
    expect(labels.get('/data/b/images')).toBe('b/images');
    expect(labels.get('/data/kitti/')).toBe('kitti');
    // inputs with absolute paths have no database
    expect(labels.has('/')).toBe(false);
  });
  it('uses the whole path when one ends another', () => {
    const labels = databaseLabels(['/images', '/data/images']);
    expect(labels.get('/images')).toBe('images');
    expect(labels.get('/data/images')).toBe('data/images');
  });
});


describe('runOriginParts', () => {
  const night = run('night', '/data/kitti', 'frames/0001.png');
  const day = run('day', '/data/kitti', 'frames/0001.png');

  it('shows the batch when the runs come from several, not the database they share', () => {
    const origins = origins_of([night, day]);
    expect(runOriginParts(night, origins).map(part => part.text)).toEqual(['night']);
    expect(runLabel(night, { parts: runOriginParts(night, origins) })).toBe('night › frames/0001.png');
  });

  it('hides the input when all the runs have it: only what differs is left', () => {
    const origins = origins_of([night, day]);
    expect(origins.same_input).toBe(true);
    expect(runLabel(night, runNameShown(night, origins))).toBe('night');
    // users who want it see it
    expect(runLabel(night, runNameShown(night, origins, 'always'))).toBe('night › kitti › frames/0001.png');
    expect(runLabel(night, runNameShown(night, origins, 'never'))).toBe('frames/0001.png');
    // with several inputs, or nothing else to tell runs apart, the input stays
    const other = run('night', '/data/kitti', 'frames/0002.png');
    expect(runLabel(night, runNameShown(night, origins_of([night, day, other])))).toBe('night › frames/0001.png');
    expect(runLabel(night, runNameShown(night, origins_of([night, run('night', '/data/kitti', 'frames/0001.png', { id: 2 })])))).toBe('frames/0001.png');
  });

  it('shows nothing when the runs come from one batch and one database', () => {
    expect(runOriginParts(night, origins_of([night]))).toEqual([]);
    // e.g. History, without the commit page's runs
    expect(runOriginParts(night, null)).toEqual([]);
  });

  it('shows the databases, shortened, when there are several', () => {
    const other = run('night', '/archive/cityscapes', 'frames/0001.png');
    const parts = runOriginParts(other, origins_of([night, other]));
    expect(parts).toEqual([{ kind: 'database', text: 'cityscapes', title: 'Database: /archive/cityscapes' }]);
  });

  it('follows the user\'s choice', () => {
    const origins = origins_of([night]);
    expect(runOriginParts(night, origins, 'always').map(part => part.text)).toEqual(['night', 'kitti']);
    expect(runOriginParts(night, origins_of([night, day]), 'never')).toEqual([]);
  });

  it('leaves pipelines and batches alone: their names are their batch', () => {
    const pipeline = run('night', '/data/kitti', 'PIPELINE');
    expect(runOriginParts(pipeline, origins_of([night, day]), 'always')).toEqual([]);
    expect(runOriginParts({ ...night, output_type: 'batch' }, null, 'always')).toEqual([]);
  });
});


describe('RunName', () => {
  const night = run('night', '/data/kitti', 'frames/0001.png', { metrics: { compute_time: 3 } });
  const day = run('day', '/data/kitti', 'frames/0002.png');
  const render_name = (origins, props) => renderWithProviders(<MemoryRouter>
    <RunOriginsContext value={origins}>
      <RunName output={night} project="p" commit={{ id: 'abc', branch: 'main' }} {...props} />
    </RunOriginsContext>
  </MemoryRouter>);

  it('starts with the batch when runs come from several', () => {
    const { container } = render_name(origins_of([night, day]));
    expect(container.querySelector('.run-name')).toHaveTextContent('night › frames/0001.png');
    expect(screen.getByTitle('Batch: night')).toHaveClass('run-origin-batch');
  });

  it('is only the batch when all runs have the same input, the input is on hover', async () => {
    const { container } = render_name(origins_of([night, run('day', '/data/kitti', 'frames/0001.png')]));
    expect(container.querySelector('.run-name')).toHaveTextContent(/^night$/);
    fireEvent.mouseEnter(screen.getByText('night').closest('.bp6-popover-target'));
    expect(await screen.findByText('Input path', {}, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.getByText('frames/0001.png')).toBeInTheDocument();
  });

  it('shows what we know about the run on hover, with the setting', async () => {
    render_name(origins_of([night]));
    expect(screen.getByText('frames/0001.png')).toBeInTheDocument();
    fireEvent.mouseEnter(screen.getByText('frames/0001.png').closest('.bp6-popover-target'));
    expect(await screen.findByText('Input path', {}, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.getByText('History')).toBeInTheDocument();
    expect(screen.getByText('Batch & database in names')).toBeInTheDocument();
  });

  it('updates when users change the setting', () => {
    const { container } = render_name(origins_of([night]));
    expect(container.querySelector('.run-name')).toHaveTextContent(/^frames\/0001.png$/);
    act(() => usePrefsStore.getState().setRunNameOrigin('always'));
    expect(container.querySelector('.run-name')).toHaveTextContent('night › kitti › frames/0001.png');
  });
});
