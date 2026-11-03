import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { regionBoxes, RegionOutlines } from '../overlays';
import { RegionsMenu, RegionsStrip } from '../panels';

const size = { width: 1000, height: 500 };
const regions = [
  { x: 100, y: 50, w: 200, h: 100, label: 'Noise', color: '#e5484d' },
  { x: 2000, y: 0, w: 10, h: 10, label: 'Outside' },
  // in the pixels of an image twice as small
  { x: 400, y: 200, w: 50, h: 25, label: 'Halo', imageWidth: 500, imageHeight: 250 },
];

describe('region outlines', () => {
  it('places the regions in the pane, without those outside the image', () => {
    const transform = { origin: { x: 10, y: 20 }, scale: 0.5 };
    expect(regionBoxes(regions, size, size, transform)).toEqual([
      { index: 0, x: 60, y: 45, w: 100, h: 50 },
      { index: 2, x: 410, y: 220, w: 50, h: 25 },
    ]);
    // the reference has another resolution: its transform is in its own pixels
    expect(regionBoxes(regions.slice(0, 1), size, { width: 2000, height: 1000 }, { origin: { x: 0, y: 0 }, scale: 0.25 }))
      .toEqual([{ index: 0, x: 50, y: 25, w: 100, h: 50 }]);
    expect(regionBoxes(regions, null, size, transform)).toEqual([]);
  });

  const controller = (pointer = null) => ({
    onDraw: () => () => {},
    subscribePointer: () => () => {},
    getPointer: () => pointer,
    geometry: pane => pane === 'b' ? 'b' : 'a',
    imageTransform: () => ({ origin: { x: 0, y: 0 }, scale: 1 }),
    screenPoint: (pane, point) => point,
  });

  it('labels the regions, and shows the one clicked', () => {
    const onSelect = vi.fn();
    render(<RegionOutlines controller={controller()} pane="a" regions={regions} active={null} size={size} paneSize={size} onSelect={onSelect} />);
    expect(screen.queryByText('Outside')).toBeNull();
    fireEvent.click(screen.getByText('Halo'));
    expect(onSelect).toHaveBeenCalledWith(2);
  });

  it('labels the active and hovered regions only, when there are many', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ x: 20 * i, y: 0, w: 15, h: 15, label: `r${i}` }));
    const { container } = render(<RegionOutlines controller={controller({ point: { x: 25, y: 5 } })} pane="a" regions={many} active={10} size={size} paneSize={size} onSelect={() => {}} />);
    expect([...container.querySelectorAll('.qiv-outline-label')].map(b => b.textContent).sort()).toEqual(['r1', 'r10']);
  });
});

describe('regions menu and strip', () => {
  it('groups the sets by section', () => {
    render(<RegionsMenu
      sets={[{ id: 'presets', label: 'Presets', regions: [] }, { id: 'iqe', label: 'IQE', section: 'Annotations', regions: [{}, {}] }]}
      selected={null} onSelect={() => {}} onCopy={() => {}} close={() => {}}
    />);
    expect(screen.getByText('Annotations')).toBeTruthy();
    expect(screen.getByText('Regions of interest')).toBeTruthy();
  });

  it('shows all the regions of overview sets, then the details of the one picked', () => {
    const onSelect = vi.fn();
    const set = { id: 'iqe', label: 'IQE', overview: true, regions: [{ ...regions[0], tags: ['night'], fields: { Importance: 'High' }, href: 'https://app/1', hrefLabel: 'Open in IQE', detail: 'Workspace 7' }] };
    const strip = index => <RegionsStrip set={set} index={index} size={size} onSelect={onSelect} onRetry={() => {}} outlines onOutlinesChange={() => {}} />;
    const { rerender } = render(strip(null));
    expect(screen.queryByText('night')).toBeNull();
    fireEvent.click(screen.getByText('All'));
    expect(onSelect).toHaveBeenCalledWith(null);
    rerender(strip(0));
    expect(screen.getByText('night')).toBeTruthy();
    expect(screen.getByText('Workspace 7')).toBeTruthy();
    expect(screen.getByText('Open in IQE').closest('a').getAttribute('href')).toBe('https://app/1');
  });
});
