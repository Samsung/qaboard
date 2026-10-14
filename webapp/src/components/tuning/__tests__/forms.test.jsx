/**
 * The Run Tests / Tuning form.
 * Run with: cd webapp && npm test -- forms
 */
import { render, screen } from '@testing-library/react';

import { TuningFormView } from '../forms';

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
