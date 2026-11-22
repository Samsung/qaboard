// Files recognized by their names: the same names as `qa upload` (tests/test_junit.py), from one list
import fs from 'fs';
import path from 'path';

import { is_junit, is_benchmarks, is_audio } from '../fileTypes';

const names = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../../../../tests/fixtures/file-types.json'), 'utf8'));

describe.each([['junit', is_junit], ['benchmarks', is_benchmarks]])('%s files', (kind, is_kind) => {
  it.each(names[kind].yes)('%s is one', name => expect(is_kind(name)).toBe(true));
  it.each(names[kind].no)("%s isn't", name => expect(is_kind(name)).toBe(false));
});

describe('audio files', () => {
  it.each(['speech.wav', 'media/audio/step-0012.WAV', 'a.mp3', 'a.flac', 'a.ogg', 'a.oga', 'a.opus', 'a.m4a', 'a.aac'])('%s is one', name => expect(is_audio(name)).toBe(true));
  // Ogg and WebM videos stay videos
  it.each(['a.ogv', 'a.webm', 'a.mp4', 'wav.txt', 'a.wav.json', '', undefined])("%s isn't", name => expect(is_audio(name)).toBe(false));
});
