/**
 * The Run Tests / Tuning form.
 * Run with: cd webapp && npm test -- forms
 */
import { render, screen } from '@testing-library/react';
import axios from 'axios';

import { TuningFormView } from '../forms';

vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn(() => Promise.resolve({ data: { tests: [] } })) } }));

vi.mock('../../MonacoEditor', () => ({ default: ({ value }) => <pre>{value}</pre> }));

const props = { project: 'kitefin/detector', config: { project: { reference_branch: 'main' }, runners: { local: {} } }, metrics: { main_metrics: ['map'], available_metrics: { map: { label: 'mAP' } }, default_metric: 'map' }, docs_root: '/', dispatch: () => {} };

describe('TuningForm', () => {
  it('runs as the logged-in user, even when they are known after the form showed', () => {
    const { rerender } = render(<TuningFormView {...props} redux_user={{ user_name: null }}/>);
    expect(screen.getByText('Please provide a user in the input below')).toBeInTheDocument();
    rerender(<TuningFormView {...props} redux_user={{ user_name: 'arjun' }}/>);
    expect(screen.queryByText('Please provide a user in the input below')).not.toBeInTheDocument();
    expect(screen.getByText(/Please give a name to the tuning experiment/)).toBeInTheDocument();
  });
});

describe('TuningForm batch', () => {
  it('says why the batch has no tests, with the name sent encoded', async () => {
    axios.post.mockResolvedValueOnce({ data: {
      tests: [],
      definitions: [],
      warnings: ['Not in this commit\'s artifacts (/mnt/a): qa/tests/x.yaml. Run `qa save-artifacts` on this commit.'],
    } });
    render(<TuningFormView {...props} redux_user={{ user_name: 'arjun' }} commit={{ id: 'abc123' }} selected_group="nightly+fs" available_tests_files={{ gr: 'extra-batches', usr: 'arjun' }}/>);
    expect(await screen.findByText('Why the batch has no tests')).toBeInTheDocument();
    expect(screen.getByText('qa save-artifacts').tagName).toBe('CODE');
    expect(axios.post).toHaveBeenCalledWith(
      '/api/v1/tests/group',
      { groups: ['extra-batches', 'arjun'] },
      { params: { project: 'kitefin/detector', name: 'nightly+fs', commit: 'abc123' } },
    );
  });
});
