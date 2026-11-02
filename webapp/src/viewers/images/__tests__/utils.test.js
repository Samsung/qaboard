import { describe, it, expect } from 'vitest';
import { iiif_url, getIiifEndpoint } from '../utils';

describe('iiif_url', () => {
  it('uses Cantaloupe\'s IIIF Image API 2 endpoint by default', () => {
    expect(iiif_url('/s/mnt/qaboard/project/run', 'output.png'))
      .toBe('/iiif/2/mnt%2Fqaboard%2Fproject%2Frun%2Foutput.png');
  });

  it('picks the image server configured for the extension', () => {
    const servers = { default: '/iiif/2/', 'raw,hex': 'https://iip.example.com/fcgi-bin/iipsrv.fcgi?IIIF=/' };
    expect(getIiifEndpoint('frame.raw', servers)).toBe('https://iip.example.com/fcgi-bin/iipsrv.fcgi?IIIF=/');
    expect(getIiifEndpoint('frame.png', servers)).toBe('/iiif/2/');
  });
});
