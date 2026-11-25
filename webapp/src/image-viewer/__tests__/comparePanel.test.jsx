import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { ComparePanel } from '../comparePanel';
import { PixelTiles } from '../pixelTiles';

// A viewer that shows one color, with the pointer on a pixel
const viewer = (color, pointer = { point: { x: 0.5, y: 0.25 } }) => ({
  subscribePointer: () => () => {},
  getPointer: () => pointer,
  onDraw: () => () => {},
  imagePixel: () => ({ x: 12, y: 34 }),
  displayPixel: () => [...color, 255],
  getSnapshot: () => ({ a: { width: 100, height: 50 } }),
  unpin: vi.fn(),
});

const entries = (controllers = [viewer([10, 20, 30]), viewer([13, 20, 25]), null]) => [
  { index: 0, name: 'new', color: '#2d72d2', textColor: '#fff', image: { url: '/new.png' }, controller: controllers[0], anchor: true },
  { index: 1, name: 'ref', color: '#9752fe', textColor: '#fff', image: { url: '/ref.png' }, controller: controllers[1], anchor: false },
  { index: 2, name: 'ref 2', color: '#cf0494', textColor: '#fff', image: { label: 'ref 2', loading: true }, controller: controllers[2], anchor: false },
];

const panel = (props = {}) => {
  const onPair = vi.fn();
  const list = entries();
  render(<ComparePanel entries={list} main={list[0].controller} tiles={new PixelTiles()} base={10} onToggleBase={() => {}} distances={[[0, 2.5, null], [2.5, 0, null], [null, null, 0]]} onPair={onPair} {...props} />);
  return { onPair };
};

describe('comparing more than two images', () => {
  it('shows the pixel under the pointer in every image, and how it differs from the anchor', () => {
    panel();
    expect(screen.getByText('x 12 y 34')).toBeTruthy();
    expect(screen.getByText('10 20 30')).toBeTruthy();
    expect(screen.getByText('13 20 25')).toBeTruthy();
    // ref − new
    expect(screen.getByText('+3 0 −5')).toBeTruthy();
    // images that are still loading keep their row
    expect(screen.getByText('ref 2: loading…')).toBeTruthy();
  });

  it('says how far apart the images are, and shows a pair alone on a click', () => {
    const { onPair } = panel();
    // each pair once
    const cells = screen.getAllByText('2.5');
    expect(cells).toHaveLength(1);
    fireEvent.click(cells[0]);
    expect(onPair).toHaveBeenCalledWith(0, 1);
    // nothing to compare with an image that isn't there
    expect(screen.getAllByText('–').every(cell => cell.disabled)).toBe(true);
  });
});
