import { render, screen, fireEvent, act } from '@testing-library/react';
import { Classes } from '@blueprintjs/core';

import { ConfigurationsTags, ConfigurationDiff, SharedConfigurationContext, qa_options } from '../ConfigurationsTags';
import { ConfigurationOverview } from '../ConfigurationOverview';
import { shared_configuration } from '../tokens';
import { usePrefsStore } from '../../stores/prefs';

const long = 'conf/projects/camera/defaults.yaml';
const runs = {
  1: { id: 1, configurations: ['base', long, { isp: { awb: 'auto' }, gain: 4 }] },
  2: { id: 2, configurations: ['base', long, { isp: { awb: 'auto' }, gain: 3 }] },
};
const shared = shared_configuration(Object.values(runs));
const withShared = (ui, value = shared) => render(<SharedConfigurationContext value={value}>{ui}</SharedConfigurationContext>);

beforeEach(() => act(() => usePrefsStore.setState({ hide_shared_settings: true })));

describe('ConfigurationsTags', () => {
  it('shows all the settings of a run shown alone, with its tuning parameters', () => {
    render(<ConfigurationsTags configurations={runs[1].configurations} tuning={{ nr: 2 }} />);
    expect(screen.getByText('base')).toBeInTheDocument();
    expect(screen.getByText(long)).toBeInTheDocument();
    expect(screen.getByText('awb')).toBeInTheDocument();
    expect(screen.getByText('nr')).toBeInTheDocument();
    expect(screen.getByTitle('Tuning parameter')).toBeInTheDocument();
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

  it('keeps hidden settings where they are when they are a prefix and a suffix', () => {
    const configurations = r => ['base', long, 'conf/common.yaml', `scene-${r}`, { lens: [1, 2], sharpen: 0.4, nr: 2 }];
    const shared = shared_configuration([{ configurations: configurations(1) }, { configurations: configurations(2) }]);
    const { container } = withShared(<ConfigurationsTags configurations={configurations(1)} />, shared);
    expect(container.textContent).toBe('3 sharedscene-13 shared');
  });

  it('puts them first when they are scattered', () => {
    const configurations = r => ['base', `a-${r}`, long, `b-${r}`, 'conf/common.yaml', `c-${r}`];
    const shared = shared_configuration([{ configurations: configurations(1) }, { configurations: configurations(2) }]);
    const { container } = withShared(<ConfigurationsTags configurations={configurations(1)} />, shared);
    expect(container.textContent).toBe('3 shareda-1b-1c-1');
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

  it('marks how the settings differ from the reference, even shared settings', () => {
    const mismatch = { configurations: ['base', 'conf/projects/camera/old.yaml', { gain: 3 }, 'debug'], extra_parameters: { nr: 1 } };
    withShared(<ConfigurationsTags configurations={runs[1].configurations} tuning={{ nr: 2 }} mismatch={mismatch} />);
    expect(screen.getByLabelText('changed: gain: 4')).toHaveTextContent('gain: 3→4');
    expect(screen.getByLabelText(`changed: ${long}`)).toHaveTextContent('conf/projects/camera/old→defaults.yaml');
    expect(screen.getByLabelText('added: isp.awb: "auto"')).toBeInTheDocument();
    expect(screen.getByLabelText('removed: debug')).toBeInTheDocument();
    expect(screen.getByLabelText('changed: nr: 2')).toHaveTextContent('nr: 1→2');
    // only "base" is shared and the same as the reference
    expect(screen.getByText('1 shared')).toBeInTheDocument();
  });
});

describe('qa_options', () => {
  it('quotes what the shell needs', () => {
    expect(qa_options(['base', 'conf/a b.yaml', { gain: 4 }], { nr: 2 }))
      .toBe(`-c base -c 'conf/a b.yaml' -c '{"gain":4}' --tuning '{"nr":2}'`);
    expect(qa_options(["it's"], {})).toBe(`-c 'it'\\''s'`);
  });
});

describe('ConfigurationDiff', () => {
  it('lists the changes with a setting around them', () => {
    const configurations = ['a', 'b', 'c', 'd', { gain: 4 }];
    render(<ConfigurationDiff configurations={configurations} mismatch={{ configurations: ['a', 'b', 'c', 'd', { gain: 3 }, 'debug'], alternatives: 2 }} />);
    expect(screen.getByText(': 1 changed, 1 removed')).toBeInTheDocument();
    expect(screen.queryByText('b')).not.toBeInTheDocument();
    expect(screen.getByText('d')).toBeInTheDocument();
    expect(screen.getByText(/2 other reference runs differ/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('3 unchanged settings'));
    expect(screen.getByText('b')).toBeInTheDocument();
  });
});

describe('ConfigurationOverview', () => {
  const batch = (outputs, ids = Object.keys(outputs)) => ({ outputs, filtered: { outputs: ids } });

  it('shows what all runs share, and the changes from the reference', () => {
    const outputs = {
      1: { ...runs[1], reference_id: 10, reference_mismatch: { configurations: runs[2].configurations, alternatives: 1 } },
      2: { ...runs[2], reference_id: 11, reference_mismatch: null },
    };
    withShared(<ConfigurationOverview new_batch={batch(outputs)} />);
    expect(screen.getByText('All 2 runs')).toBeInTheDocument();
    expect(screen.getByText(/1 of 2 runs/)).toBeInTheDocument();
    expect(screen.getByText('gain')).toBeInTheDocument();
    expect(screen.getByText(/1 run had several reference runs/)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Hide them/ })).toBeChecked();
  });

  it('says when runs are filtered', () => {
    withShared(<ConfigurationOverview new_batch={batch({ ...runs, 3: { id: 3, configurations: ['other'] } }, ['1', '2'])} />);
    expect(screen.getByText('All 2 filtered runs')).toBeInTheDocument();
  });

  it('says nothing when there is nothing to say', () => {
    const { container } = render(<ConfigurationOverview new_batch={batch({ 1: { id: 1, configurations: ['base'], reference_id: 2 } })} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('lists', () => {
  it('shortens long lists, with their size', () => {
    const lut = Array.from({ length: 256 }, (_, i) => i);
    const { container } = render(<ConfigurationsTags configurations={[{ lut, ccm: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], gains: [1, 0.98] }]} />);
    expect([...container.querySelectorAll(`.${Classes.TAG}`)].map(tag => tag.textContent)).toEqual([
      'lut: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, …] 256 values',
      'ccm: [[1, 0, 0], [0, 1, 0], [0, 0, 1]]',
      'gains: [1, 0.98]',
    ]);
  });

  it('shows where long lists changed', () => {
    const lut = Array.from({ length: 64 }, (_, i) => i);
    const changed = lut.map(v => v === 40 ? 41 : v);
    render(<ConfigurationsTags configurations={[{ lut: changed }]} mismatch={{ configurations: [{ lut }] }} />);
    expect(screen.getByLabelText(/^changed: lut/)).toHaveTextContent('lut: …37, 38, 39, 40→41, 41, 42, 43…');
  });

  it('copies a setting of a list of objects as JSON', () => {
    expect(qa_options([{ layers: [{ stride: 2 }] }])).toBe(`-c '{"layers":[{"stride":2}]}'`);
  });
});
