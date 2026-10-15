/**
 * Tests for the visual controls of outputs.
 * Run with: cd webapp && npm test -- controls
 */
import { controls_defaults, save_controls } from '../controls';
import { history } from '../../router';
import { parse_query } from '../../selection';


describe('controls_defaults', () => {
  const config = {
    outputs: {
      controls: [{ name: 'show_reference', default: true }],
      visualizations: [{ name: 'debug', default_hidden: true }, { name: 'output' }],
    },
  };

  it('uses the defaults from the configuration', () => {
    expect(controls_defaults(config, '')).toMatchObject({ show_reference: true, show: { debug: false }, dynamic_options: {} });
  });

  it('uses the controls from the URL', () => {
    const search = `?controls=${encodeURIComponent(JSON.stringify({ show_reference: false }))}`;
    expect(controls_defaults(config, search).show_reference).toBe(false);
    expect(controls_defaults(config, '?controls=not-json').show_reference).toBe(true);
  });

  it('works without configuration', () => {
    expect(controls_defaults(undefined, '')).toMatchObject({ show: {}, dynamic_options: {} });
  });
});


describe('save_controls', () => {
  it("replaces the URL: toggles don't add history entries", () => {
    const push = vi.spyOn(history, 'push');
    const replace = vi.spyOn(history, 'replace');
    save_controls({ show_reference: false });
    expect(push).not.toHaveBeenCalled();
    expect(parse_query(window.location.search).controls).toBe(JSON.stringify({ show_reference: false }));
    expect(replace).toHaveBeenCalledTimes(1);
  });
});


describe('the URL only has what differs from the defaults', () => {
  const config = {
    outputs: {
      controls: [{ name: 'show_reference', default: true }],
      visualizations: [{ name: 'debug', default_hidden: true }, { name: 'output' }],
    },
  };
  const url_controls = () => {
    const { controls } = parse_query(window.location.search);
    return controls === undefined ? undefined : JSON.parse(controls);
  };

  it('keeps only the changes', () => {
    const controls = controls_defaults(config, '');
    save_controls({ ...controls, show: { debug: true, output: true }, dynamic_options: { frame: ['2'] }, dynamic_options_sync: { camera: false, frame: undefined } }, config);
    expect(url_controls()).toEqual({ show: { debug: true }, dynamic_options: { frame: ['2'] }, dynamic_options_sync: { camera: false } });
  });

  it('removes the parameter with only defaults', () => {
    save_controls({ show_reference: false }, config);
    expect(url_controls()).toEqual({ show_reference: false });
    save_controls(controls_defaults(config, ''), config);
    expect(url_controls()).toBeUndefined();
  });

  it('reads back the same controls', () => {
    const controls = { ...controls_defaults(config, ''), show_reference: false, show: { debug: true, output: false } };
    save_controls(controls, config);
    expect(controls_defaults(config, window.location.search)).toEqual(controls);
  });

  it('ignores URLs with something else than an object', () => {
    expect(controls_defaults(config, '?controls=[1]').show).toEqual({ debug: false });
  });
});
