import { render, screen, fireEvent, act } from '@testing-library/react';

import { ConfigurationsTags, ConfigurationDiff, SharedConfigurationContext } from '../ConfigurationsTags';
import { ConfigurationOverview } from '../ConfigurationOverview';
import { shared_configuration } from '../tokens';
import { usePrefsStore } from '../../stores/prefs';

const long = 'conf/projects/camera/defaults.yaml';
const runs = {
  1: { id: 1, configurations: ['base', long, { isp: { awb: 'auto' }, gain: 4 }] },
  2: { id: 2, configurations: ['base', long, { isp: { awb: 'auto' }, gain: 3 }] },
};
const shared = shared_configuration(runs);
const withShared = ui => render(<SharedConfigurationContext value={shared}>{ui}</SharedConfigurationContext>);

beforeEach(() => act(() => usePrefsStore.setState({ hide_shared_settings: true })));

describe('ConfigurationsTags', () => {
  it('shows all the settings of a run shown alone', () => {
    render(<ConfigurationsTags configurations={runs[1].configurations} />);
    expect(screen.getByText('base')).toBeInTheDocument();
    expect(screen.getByText(long)).toBeInTheDocument();
    expect(screen.getByText('awb')).toBeInTheDocument();
  });

  it('hides what all runs share, and shows it on click', () => {
    withShared(<ConfigurationsTags configurations={runs[1].configurations} />);
    expect(screen.queryByText('base')).not.toBeInTheDocument();
    expect(screen.getByText('gain')).toBeInTheDocument();
    fireEvent.click(screen.getByText('3 shared'));
    expect(screen.getByText('base')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Hide shared'));
    expect(screen.queryByText('base')).not.toBeInTheDocument();
  });

  it('shows everything when users prefer', () => {
    act(() => usePrefsStore.setState({ hide_shared_settings: false }));
    withShared(<ConfigurationsTags configurations={runs[1].configurations} />);
    expect(screen.getByText('base')).toBeInTheDocument();
    expect(screen.queryByText('3 shared')).not.toBeInTheDocument();
  });

  it("doesn't hide anything where we show the full configuration", () => {
    withShared(<ConfigurationsTags configurations={runs[1].configurations} collapse={false} />);
    expect(screen.getByText('base')).toBeInTheDocument();
  });

  it('marks how the configuration differs from the reference, even shared settings', () => {
    withShared(<ConfigurationsTags configurations={runs[1].configurations} reference={['base', 'conf/projects/camera/old.yaml', { gain: 3 }, 'debug']} />);
    expect(screen.getByLabelText('changed: gain: 4')).toHaveTextContent('gain: 3→4');
    expect(screen.getByLabelText(`changed: ${long}`)).toHaveTextContent('conf/projects/camera/old→defaults.yaml');
    expect(screen.getByLabelText('added: isp.awb: "auto"')).toBeInTheDocument();
    expect(screen.getByLabelText('removed: debug')).toBeInTheDocument();
    // only "base" is shared and the same as the reference
    expect(screen.getByText('1 shared')).toBeInTheDocument();
  });
});

describe('ConfigurationDiff', () => {
  it('lists the changes with a setting around them', () => {
    const configurations = ['a', 'b', 'c', 'd', { gain: 4 }];
    render(<ConfigurationDiff configurations={configurations} reference={['a', 'b', 'c', 'd', { gain: 3 }, 'debug']} />);
    expect(screen.getByText(': 1 changed, 1 removed')).toBeInTheDocument();
    expect(screen.queryByText('b')).not.toBeInTheDocument();
    expect(screen.getByText('d')).toBeInTheDocument();
    fireEvent.click(screen.getByText('3 unchanged settings'));
    expect(screen.getByText('b')).toBeInTheDocument();
  });
});

describe('ConfigurationOverview', () => {
  const batch = (outputs, ids = Object.keys(outputs)) => ({ outputs, filtered: { outputs: ids } });

  it('shows what all runs share, and the changes from the reference', () => {
    const outputs = {
      1: { ...runs[1], reference_id: 10, reference_mismatch: { configurations: runs[2].configurations } },
      2: { ...runs[2], reference_id: 11, reference_mismatch: null },
    };
    withShared(<ConfigurationOverview new_batch={batch(outputs)} />);
    expect(screen.getByText('All 2 runs')).toBeInTheDocument();
    expect(screen.getByText(/1 of 2 runs/)).toBeInTheDocument();
    expect(screen.getByText('gain')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Hide them/ })).toBeChecked();
  });

  it('says nothing when there is nothing to say', () => {
    const { container } = render(<ConfigurationOverview new_batch={batch({ 1: { id: 1, configurations: ['base'], reference_id: 2 } })} />);
    expect(container).toBeEmptyDOMElement();
  });
});
