import { describe, it, expect } from 'vitest';
import fixture from '../../../../tests/fixtures/export-names.json';
import { file_name, input_fields, split_extension, parse_template, ExportNameError } from '../names';

// qaboard/export_names.py renders the names when the server exports: the same cases (tests/test_export_names.py)
describe('export names, like the server', () => {
  const cases = c => [c.template, c.file, c.separator, c];
  it.each(fixture.names.filter(c => !c.error).map(cases))('%s %s %s', (template, file, separator, c) => {
    expect(file_name(template, c.fields, file, separator)).toBe(c.name);
  });
  it.each(fixture.names.filter(c => c.error).map(cases))('refuses %s %s %s', (template, file, separator, c) => {
    expect(() => file_name(template, c.fields, file, separator)).toThrow(ExportNameError);
  });

  it('names inputs and splits extensions', () => {
    for (const c of fixture.inputs) expect(input_fields(c.path)).toEqual({ input: c.input, input_name: c.input_name });
    for (const c of fixture.extensions) expect(split_extension(c.path)).toEqual(c.split);
  });

  it('says which fields exist', () => {
    expect(() => parse_template('{input}__{foo}')).toThrow(/Unknown field \{foo\}/);
    expect(parse_template('{side}/{file}').map(p => p.text)).toEqual(['side', '/', 'file']);
  });
});
