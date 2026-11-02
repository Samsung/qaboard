/**
 * Tooltips and menus for long lists are only created when users get to them, and then work like Blueprint's.
 * Run with: cd webapp && npm test -- LazyPopover
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Button, Menu, MenuItem, Tag } from '@blueprintjs/core';

import { LazyPopover, LazyTooltip } from '../LazyPopover';


const popovers = () => document.querySelectorAll('.bp6-popover-target, .bp6-overlay').length;

test('a tooltip is created when users point at its target for a moment', async () => {
  render(<LazyTooltip content="Waiting for a runner" className="metric"><Tag minimal>2 pending</Tag></LazyTooltip>);
  const target = screen.getByText('2 pending').closest('.bp6-popover-target');
  // laid out like a tooltip's target
  expect(target).toHaveClass('metric');
  expect(document.querySelector('.bp6-overlay')).toBeNull();

  // passing by doesn't create it
  fireEvent.mouseEnter(target);
  fireEvent.mouseLeave(target);
  await act(() => new Promise(resolve => setTimeout(resolve, 150)));
  expect(screen.queryByText('Waiting for a runner')).not.toBeInTheDocument();

  fireEvent.mouseEnter(screen.getByText('2 pending').closest('.bp6-popover-target'));
  expect(await screen.findByText('Waiting for a runner')).toBeInTheDocument();
  expect(screen.getByText('2 pending')).toBeInTheDocument();
});

test('clicking a target leaves it as it is', async () => {
  const onClick = vi.fn();
  render(<LazyTooltip content="Copy the commit hash"><Button aria-label="Copy" onClick={onClick}/></LazyTooltip>);
  const button = screen.getByLabelText('Copy');
  fireEvent.mouseEnter(button);
  fireEvent.pointerDown(button, { pointerType: 'mouse' });
  fireEvent.mouseDown(button);
  await act(() => new Promise(resolve => setTimeout(resolve, 150)));
  fireEvent.click(button);
  expect(onClick).toHaveBeenCalled();
  expect(screen.getByLabelText('Copy')).toBe(button);
  expect(screen.queryByText('Copy the commit hash')).not.toBeInTheDocument();
});

test('tapping a target shows its tooltip', async () => {
  render(<LazyTooltip content="Waiting for a runner"><Tag minimal>2 pending</Tag></LazyTooltip>);
  const target = screen.getByText('2 pending').closest('.bp6-popover-target');
  // touch screens fire the mouse events after the touch, all at once
  fireEvent.pointerDown(target, { pointerType: 'touch' });
  fireEvent.mouseEnter(target);
  fireEvent.mouseDown(target);
  fireEvent.mouseUp(target);
  fireEvent.click(target);
  expect(await screen.findByText('Waiting for a runner')).toBeInTheDocument();
});

test('a tooltip is created when its target is focused with the keyboard, which keeps the focus', async () => {
  render(<LazyTooltip content="View the commit's diff"><a href="https://example.com/commit">abcdef12</a></LazyTooltip>);
  const before = screen.getByText('abcdef12');
  fireEvent.keyDown(document.body, { key: 'Tab' });
  act(() => before.focus());
  const link = screen.getByText('abcdef12');
  expect(link).not.toBe(before);
  expect(link).toHaveFocus();
  expect(await screen.findByText("View the commit's diff")).toBeInTheDocument();
});

test('a menu is created open by the first click, then works as usual', async () => {
  render(<LazyPopover content={<Menu><MenuItem text="Copy directory"/></Menu>}><Button aria-label="Commit actions"/></LazyPopover>);
  expect(popovers()).toBe(1);
  // screen readers know it's a menu button before it's created
  expect(screen.getByLabelText('Commit actions')).toHaveAttribute('aria-haspopup', 'menu');
  expect(screen.getByLabelText('Commit actions')).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(screen.getByLabelText('Commit actions'));
  expect(await screen.findByText('Copy directory')).toBeInTheDocument();
  expect(screen.getByLabelText('Commit actions')).toHaveAttribute('aria-expanded', 'true');
});
