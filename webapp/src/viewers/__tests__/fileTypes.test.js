// Files recognized by their names: the same names as `qa upload` (tests/test_junit.py), from one list
import fs from 'fs';
import path from 'path';

import { is_junit, is_benchmarks } from '../fileTypes';

const names = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../../../../tests/fixtures/file-types.json'), 'utf8'));

describe.each([['junit', is_junit], ['benchmarks', is_benchmarks]])('%s files', (kind, is_kind) => {
  it.each(names[kind].yes)('%s is one', name => expect(is_kind(name)).toBe(true));
  it.each(names[kind].no)("%s isn't", name => expect(is_kind(name)).toBe(false));
});
