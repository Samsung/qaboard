import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';

import { OptimizeSetup } from '../OptimizeSetup';
import { template } from '../optimize_config';
import { renderWithProviders } from '../../../test-utils';

const Harness = ({ initial }) => {
  const [value, setValue] = useState(initial);
  return <>
    <OptimizeSetup value={value} onChange={setValue}/>
    <button onClick={() => setValue(value.replace(/^evaluations: \d+$/m, 'evaluations: 50'))}>edit the YAML</button>
    <pre data-testid="yaml">{value}</pre>
  </>;
};

describe('OptimizeSetup number fields', () => {
  it('keep what users type, and follow the YAML when it changes elsewhere', () => {
    renderWithProviders(<Harness initial={template()}/>);
    const field = screen.getByLabelText('Evaluations');
    expect(field).toHaveValue('30');

    // a valid number is written to the YAML, the text stays as typed
    fireEvent.change(field, { target: { value: '4.' } });
    expect(screen.getByTestId('yaml').textContent).toMatch(/^evaluations: 4$/m);
    expect(field).toHaveValue('4.');
    // not yet a number: the YAML keeps the last one
    fireEvent.change(field, { target: { value: '4e' } });
    expect(field).toHaveValue('4e');
    expect(screen.getByTestId('yaml').textContent).toMatch(/^evaluations: 4$/m);

    fireEvent.click(screen.getByText('edit the YAML'));
    expect(field).toHaveValue('50');
  });
});
