import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { Crop, fitTo, isValidRoi, scale_roi, output_rois } from '../crops';
import { RoiViewer } from '../roi_viewer';


// The test input's metadata gives ROIs in the coordinates of a 2000x1000 image,
// and the viewer shows a 1000x500 output: ROIs must be scaled by 1/2 on both axes.
const roi = { x: 100, y: 50, w: 400, h: 200, image_width: 2000, image_height: 1000, label: 'Detail' };
const expected = { x: 50, y: 25, w: 200, h: 100 };

// A minimal OpenSeadragon viewer: image coordinates are normalized by the image width
const fakeViewer = (width = 1000, height = 500) => ({
  source: { width, height },
  viewport: {
    imageToViewportRectangle: vi.fn((x, y, w, h) => ({ x: x / width, y: y / width, width: w / width, height: h / width })),
    zoomTo: vi.fn(),
    panTo: vi.fn(),
    goHome: vi.fn(),
  },
  world: { getItemAt: () => ({ getContentSize: () => ({ x: width, y: height }) }) },
  addOnceHandler: vi.fn(),
});

const output = { output_dir_url: '/s/mnt/qaboard/project/run', configurations: ['base'] };


describe('output_rois', () => {
  it('lists unique ROIs from the input metadata and the configurations, without changing the output', () => {
    const roi = { x: 0, y: 0, w: 10, h: 10, label: 'a' };
    const output = Object.freeze({
      configurations: Object.freeze(['base', Object.freeze({ roi: Object.freeze([Object.freeze({ ...roi }), Object.freeze({ x: 5, y: 5, w: 1, h: 1, label: 'b' })]) })]),
      test_input_metadata: Object.freeze({ roi: Object.freeze([Object.freeze(roi)]), width: 100, height: 50 }),
    });
    const rois = output_rois(output);
    expect(rois.map(r => r.label)).toEqual(['a', 'b', 'Full Image']);
    expect(rois[0]).toMatchObject({ ...roi, image_width: 100, image_height: 50 });
    expect(roi).not.toHaveProperty('key');
  });

  it('has nothing to show without ROIs', () => {
    expect(output_rois({ configurations: [] })).toEqual([]);
  });
});


describe('scale_roi', () => {
  it('scales x and w by the width, y and h by the height, for non-square images', () => {
    expect(scale_roi(roi, { width: 1000, height: 500 })).toEqual(expected);
  });

  it('keeps ROIs that have no image size', () => {
    expect(scale_roi({ x: 1, y: 2, w: 3, h: 4 }, { width: 1000, height: 500 })).toEqual({ x: 1, y: 2, w: 3, h: 4 });
  });

  it('keeps ROIs before the viewer has an image', () => {
    expect(scale_roi(roi, undefined)).toEqual({ x: 100, y: 50, w: 400, h: 200 });
  });
});


describe('Crop', () => {
  it('requests the scaled ROI', () => {
    render(<Crop roi={roi} output={output} path="out.png" viewer={fakeViewer()} />);
    expect(screen.getByRole('img', { name: 'Detail' })).toHaveAttribute(
      'src', '/iiif/2/mnt%2Fqaboard%2Fproject%2Frun%2Fout.png/50,25,200,100/,50/0/default.jpg',
    );
  });

  it('shows the TIFF the viewer shows when the run has one', () => {
    const manifest = { 'out.tiff': { st_size: 100, md5: 'abc' } };
    render(<Crop roi={roi} output={output} path="out.png" manifest={manifest} viewer={fakeViewer()} />);
    expect(screen.getByRole('img', { name: 'Detail' }).getAttribute('src'))
      .toMatch(/^\/iiif\/2\/mnt%2Fqaboard%2Fproject%2Frun%2Fout\.tiff\//);
  });

  it('uses the image server configured for the extension', () => {
    const imageServers = { default: '/iiif/2/', 'raw,hex': 'https://iip.example.com/iipsrv.fcgi?IIIF=/' };
    render(<Crop roi={{ label: 'Full Image' }} output={output} path="frame.raw" imageServers={imageServers} viewer={fakeViewer()} />);
    expect(screen.getByRole('img', { name: 'Full Image' })).toHaveAttribute(
      'src', 'https://iip.example.com/iipsrv.fcgi?IIIF=/mnt%2Fqaboard%2Fproject%2Frun%2Fframe.raw/full/,50/0/default.jpg',
    );
  });

  it("doesn't request thumbnails of ROIs outside the image", () => {
    const outside = { x: 5000, y: 50, w: 400, h: 200, label: 'Outside' };
    render(<Crop roi={outside} output={output} path="out.png" viewer={fakeViewer()} />);
    expect(screen.queryByRole('img', { name: 'Outside' })).toBeNull();
    expect(screen.getByText('invalid')).toBeInTheDocument();
  });
});


describe('isValidRoi', () => {
  it('checks the ROI in the coordinates of the viewed image', () => {
    // x+w is past the 1000px of the viewed image, but not past the 2000px of the input
    const right = { ...roi, x: 1500, w: 400 };
    expect(isValidRoi(right, fakeViewer())).toBe(true);
    expect(isValidRoi({ ...right, x: 2500 }, fakeViewer())).toBe(false);
  });
});


describe('fitTo', () => {
  it('zooms on the scaled ROI', () => {
    const viewer = fakeViewer();
    fitTo(roi, viewer);
    expect(viewer.viewport.imageToViewportRectangle).toHaveBeenLastCalledWith(expected.x, expected.y, expected.w, expected.h);
    expect(viewer.viewport.zoomTo).toHaveBeenCalledWith(1000 / expected.w);
    expect(viewer.viewport.panTo).toHaveBeenCalledWith({
      x: expect.closeTo((expected.x + expected.w / 2) / 1000),
      y: expect.closeTo((expected.y + expected.h / 2) / 1000),
    });
  });
});


describe('RoiViewer', () => {
  it('shows ROI thumbnails of the image the viewer shows', () => {
    const output_new = {
      ...output,
      test_input_metadata: { width: 2000, height: 1000, roi: [{ x: 100, y: 50, w: 400, h: 200, label: 'Detail' }] },
    };
    const manifest = { 'out.tiff': { st_size: 100, md5: 'abc' } };
    const imageServers = { default: '/iiif/cantaloupe/' };
    render(<RoiViewer
      output_new={output_new}
      path="out.png"
      manifest={manifest}
      imageServers={imageServers}
      viewer={fakeViewer()}
      current_roi={{}}
      fullyLoaded
    />);
    expect(screen.getByRole('img', { name: 'Detail' })).toHaveAttribute(
      'src', '/iiif/cantaloupe/mnt%2Fqaboard%2Fproject%2Frun%2Fout.tiff/50,25,200,100/,50/0/default.jpg',
    );
    expect(screen.getByRole('img', { name: 'Full Image' })).toHaveAttribute(
      'src', '/iiif/cantaloupe/mnt%2Fqaboard%2Fproject%2Frun%2Fout.tiff/full/,50/0/default.jpg',
    );
  });
});
