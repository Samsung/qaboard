/**
 * Things users click, like cards, are buttons for keyboards too.
 * Run with: cd webapp && npm test -- pressable
 */
import { render, screen, fireEvent } from '@testing-library/react';

import { pressable } from '../pressable';


test('Tab gets there, Enter and Space press it, not keys pressed inside', () => {
  const onPress = vi.fn();
  render(<div {...pressable(onPress)} aria-label="Exports">
    <input aria-label="Inside"/>
  </div>);
  const button = screen.getByRole('button', { name: 'Exports' });
  expect(button).toHaveAttribute('tabindex', '0');
  fireEvent.click(button);
  fireEvent.keyDown(button, { key: 'Enter' });
  fireEvent.keyDown(button, { key: ' ' });
  expect(onPress).toHaveBeenCalledTimes(3);
  fireEvent.keyDown(button, { key: 'a' });
  fireEvent.keyDown(screen.getByLabelText('Inside'), { key: 'Enter' });
  expect(onPress).toHaveBeenCalledTimes(3);
});
