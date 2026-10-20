import { describe, expect, it } from 'vitest';

import { parsePcd } from '../pointcloud/pcd';
import { pointCloudLayers } from '../pointcloud/PointCloudViewer';
import { side_color } from '../../sideColors';

const header = (fields, data, points, extra = {}) => [
  '# .PCD v0.7 - Point Cloud Data file format',
  'VERSION 0.7',
  `FIELDS ${fields.map(f => f.name).join(' ')}`,
  `SIZE ${fields.map(f => f.size).join(' ')}`,
  `TYPE ${fields.map(f => f.type).join(' ')}`,
  `COUNT ${fields.map(f => f.count ?? 1).join(' ')}`,
  `WIDTH ${points}`,
  'HEIGHT 1',
  'VIEWPOINT 0 0 0 1 0 0 0',
  `POINTS ${extra.points ?? points}`,
  `DATA ${data}`,
].join('\n') + '\n';

describe('parsePcd', () => {
  it('reads ascii files, with other fields between x y z', () => {
    const fields = [{ name: 'x', size: 4, type: 'F' }, { name: 'intensity', size: 4, type: 'F', count: 2 }, { name: 'y', size: 4, type: 'F' }, { name: 'z', size: 4, type: 'F' }];
    const text = header(fields, 'ascii', 2) + '1.5 9 9 2 3\n-1 9 9 0.25 4\n';
    const { positions, count } = parsePcd(text);
    expect(count).toBe(2);
    expect(Array.from(positions)).toEqual([1.5, 2, 3, -1, 0.25, 4]);
  });

  it('reads binary files, from an ArrayBuffer', () => {
    const fields = [{ name: 'x', size: 4, type: 'F' }, { name: 'y', size: 4, type: 'F' }, { name: 'z', size: 8, type: 'F' }, { name: 'rgb', size: 4, type: 'U' }];
    const head = new TextEncoder().encode(header(fields, 'binary', 2));
    const stride = 4 + 4 + 8 + 4;
    const buffer = new ArrayBuffer(head.length + 2 * stride);
    new Uint8Array(buffer).set(head);
    const view = new DataView(buffer, head.length);
    [[1, 2, 3], [4, 5, 6]].forEach(([x, y, z], i) => {
      view.setFloat32(i * stride, x, true);
      view.setFloat32(i * stride + 4, y, true);
      view.setFloat64(i * stride + 8, z, true);
      view.setUint32(i * stride + 16, 0xffffff, true);
    });
    const { positions, count } = parsePcd(buffer);
    expect(count).toBe(2);
    expect(Array.from(positions)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('explains what it does not read', () => {
    const xyz = ['x', 'y', 'z'].map(name => ({ name, size: 4, type: 'F' }));
    expect(() => parsePcd(header(xyz, 'binary_compressed', 1))).toThrow(/ascii or binary/);
    expect(() => parsePcd(header([{ name: 'range', size: 4, type: 'F' }], 'ascii', 1))).toThrow(/no x, y and z/);
    expect(() => parsePcd('VERSION 0.7\n')).toThrow(/Not a PCD file/);
  });
});


describe('pointCloudLayers', () => {
  it('names and colors the new and reference clouds like the other viewers', () => {
    const [groundtruth, reference, new_] = pointCloudLayers(undefined, false);
    expect([new_.label, reference.label, groundtruth.label]).toEqual(['new', 'reference', 'ground truth']);
    expect([new_.color, new_.css]).toEqual([side_color(0).hex, side_color(0).css]);
    expect([reference.color, reference.css]).toEqual([side_color(1).hex, side_color(1).css]);
    // what the commit page calls them, e.g. a milestone, with its color, in the theme
    const labels = { new: 'new', reference: 'fw-26-08', colors: { new: side_color(0), reference: side_color(2) } };
    const layers = pointCloudLayers(labels, true);
    expect(layers.map(layer => layer.label)).toEqual(['ground truth', 'fw-26-08', 'new']);
    expect(layers[1].color).toBe(side_color(2).hex_dark);
  });
});
