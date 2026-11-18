import { describe, it, expect } from 'vitest';

import { otherReferenceImage } from '../QaboardImageViewer';

const color = { hex: '#cf0494', text: '#ffffff' };
const output = { id: 7, output_dir_url: '/s/runs/7' };
const other = fields => ({ key: 'reference-2', label: 'v1.2', color, output, manifest: { 'out.png': { md5_data: 'aaa' } }, loading: false, ...fields });
const shown = [{ label: 'new', meta: { md5_data: 'bbb' } }, { label: 'ref', meta: { md5_data: 'ccc' } }];

describe('the other references shown together', () => {
  it('shows the same file of the matching run, in the reference\'s color', () => {
    const { image, meta } = otherReferenceImage({ other: other(), path: 'out.png', image_servers: undefined, shown });
    expect(image).toMatchObject({ label: 'v1.2', color: '#cf0494', textColor: '#ffffff', file: '/s/runs/7/out.png' });
    expect(image.iiif).toContain('out.png');
    expect(meta).toEqual({ md5_data: 'aaa' });
  });

  it('says when the file is identical to one already shown', () => {
    const { image } = otherReferenceImage({ other: other({ manifest: { 'out.png': { md5_data: 'ccc' } } }), path: 'out.png', image_servers: undefined, shown });
    expect(image.label).toBe('v1.2 = ref');
  });

  it('keeps its place while it loads, or without a run or a file', () => {
    const placeholder = fields => otherReferenceImage({ other: other(fields), path: 'out.png', image_servers: undefined, shown }).image;
    expect(placeholder({ loading: true, output: undefined, manifest: undefined })).toEqual({ label: 'v1.2', color: '#cf0494', textColor: '#ffffff', loading: true });
    expect(placeholder({ manifest: undefined })).toMatchObject({ loading: true });
    expect(placeholder({ output: undefined, manifest: undefined })).toMatchObject({ missing: 'No run of v1.2 matches this one' });
    expect(placeholder({ output: { ...output, deleted: true } })).toMatchObject({ missing: 'The run of v1.2 was deleted' });
    expect(placeholder({ manifest: {} })).toMatchObject({ missing: 'No out.png in v1.2' });
    // a run without files: not "loading" forever
    expect(placeholder({ output: { id: 7 }, manifest: undefined })).toMatchObject({ missing: 'The run of v1.2 was deleted' });
    expect(placeholder({ loading: false, output: undefined, manifest: undefined, error: 'Not found' })).toMatchObject({ missing: "Can't load v1.2: Not found" });
  });

  it('falls back to the TIFF or BMP version of a PNG', () => {
    const { image } = otherReferenceImage({ other: other({ manifest: { 'out.bmp': { md5_data: 'ddd' } } }), path: 'out.png', image_servers: undefined, shown });
    expect(image.file).toBe('/s/runs/7/out.bmp');
  });
});
