// Point Cloud Data files (PCL's .pcd): the header, then the points, in ascii or binary (not binary_compressed).
// Returns {positions: Float32Array of x y z, count}: the other fields are skipped.
// https://pointclouds.org/documentation/tutorials/pcd_file_format.html

const TYPES = {
  F: { 4: 'getFloat32', 8: 'getFloat64' },
  I: { 1: 'getInt8', 2: 'getInt16', 4: 'getInt32' },
  U: { 1: 'getUint8', 2: 'getUint16', 4: 'getUint32' },
};

export const parsePcd = data => {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new TextEncoder().encode(data);
  // the header is ascii, and ends with the DATA line
  let end = 0;
  let header = {};
  let line_start = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 10) continue;
    const line = new TextDecoder().decode(bytes.subarray(line_start, i)).trim();
    line_start = i + 1;
    if (!line || line.startsWith('#')) continue;
    const [key, ...values] = line.split(/\s+/);
    header[key.toUpperCase()] = values;
    if (key.toUpperCase() === 'DATA') {
      end = i + 1;
      break;
    }
  }
  if (!header.DATA)
    throw new Error('Not a PCD file: no DATA line');
  const fields = header.FIELDS ?? [];
  const sizes = (header.SIZE ?? fields.map(() => '4')).map(Number);
  const types = header.TYPE ?? fields.map(() => 'F');
  const counts = (header.COUNT ?? fields.map(() => '1')).map(Number);
  const count = Number(header.POINTS?.[0] ?? (Number(header.WIDTH?.[0] ?? 0) * Number(header.HEIGHT?.[0] ?? 1)));
  const axes = ['x', 'y', 'z'].map(axis => fields.indexOf(axis));
  if (axes.some(index => index < 0))
    throw new Error(`The PCD file has no x, y and z fields: ${fields.join(' ')}`);
  const positions = new Float32Array(count * 3);
  const format = header.DATA[0].toLowerCase();

  if (format === 'ascii') {
    // the column of each field: fields with a COUNT take several
    const columns = [];
    let column = 0;
    fields.forEach((_, f) => { columns.push(column); column += counts[f]; });
    const lines = new TextDecoder().decode(bytes.subarray(end)).split('\n');
    let n = 0;
    for (const line of lines) {
      if (n >= count) break;
      const values = line.trim().split(/\s+/);
      if (values.length < column) continue;
      axes.forEach((f, a) => { positions[3 * n + a] = parseFloat(values[columns[f]]); });
      n++;
    }
    return { positions: positions.subarray(0, 3 * n), count: n };
  }
  if (format === 'binary') {
    const offsets = [];
    let stride = 0;
    fields.forEach((_, f) => { offsets.push(stride); stride += sizes[f] * counts[f]; });
    const view = new DataView(bytes.buffer, bytes.byteOffset + end);
    const n = Math.min(count, Math.floor(view.byteLength / stride));
    const getters = axes.map(f => {
      const getter = TYPES[types[f]]?.[sizes[f]];
      if (!getter) throw new Error(`Unsupported PCD type ${types[f]}${sizes[f]}`);
      return getter;
    });
    for (let i = 0; i < n; i++)
      axes.forEach((f, a) => { positions[3 * i + a] = view[getters[a]](i * stride + offsets[f], true); });
    return { positions: positions.subarray(0, 3 * n), count: n };
  }
  throw new Error(`PCD files with DATA ${format} aren't supported: save them as ascii or binary`);
};
