import { add_rules, preferences_for, preferred_score, rules_from_query, rules_to_selection, run_facts, fact_text } from '../rules';
import { parse_query } from '../../selection';

describe('reference rules', () => {
  it('reads and writes the rules in the URL', () => {
    const query = parse_query('?pair=reg0x1A%3D05%7Creg0x1A%3D03&prefer=platform%3Darm&pin=12%3A34');
    const rules = rules_from_query(query);
    expect(rules).toEqual({ pairs: [{ from: 'reg0x1A=05', to: 'reg0x1A=03' }], prefer: [{ key: 'platform', value: 'arm' }], pins: { 12: '34' }, custom: true });
    expect(rules_to_selection(rules)).toEqual({ pair: ['reg0x1A=05|reg0x1A=03'], prefer: ['platform=arm'], pin: ['12:34'] });
    // the same object for the same rules: runs are matched again only when they change
    expect(rules_from_query(parse_query('?pin=12%3A34&prefer=platform%3Darm&pair=reg0x1A%3D05%7Creg0x1A%3D03&other=1'))).toBe(rules);
    expect(rules_from_query({}).custom).toBe(false);
    expect(rules_from_query({ pair: 'no-separator', pin: 'x' }).custom).toBe(false);
  });

  it('knows facts about runs, to prefer reference runs', () => {
    const run = { platform: 'arm', extra_parameters: { isp: { gain: 4 } }, test_input_metadata: { id: 'scene', sensor: 'imx766', roi: [] }, configurations: ['low-light', { a: 1 }] };
    expect(run_facts(run)).toEqual({ platform: 'arm', 'param:isp.gain': '4', 'meta:sensor': 'imx766', 'config:low-light': 'yes' });
    const other = { platform: 'x86', extra_parameters: { isp: { gain: 4 } }, test_input_metadata: {}, configurations: [] };
    expect(preferences_for(run, other).map(fact_text)).toEqual(['platform = arm', 'sensor = imx766', 'low-light']);
    expect(preferred_score(run, [{ key: 'platform', value: 'arm' }, { key: 'meta:sensor', value: 'other' }])).toBe(1);
  });

  it('keeps separators and % in what the URL splits', () => {
    const rules = { pairs: [{ from: 'a|b%7C', to: 'c|d' }], prefer: [{ key: 'param:a=b', value: '1=2' }], pins: {} };
    const query = parse_query(`?${new URLSearchParams(Object.entries(rules_to_selection(rules)).flatMap(([k, vs]) => vs.map(v => [k, v])))}`);
    expect(rules_from_query(query)).toMatchObject({ pairs: rules.pairs, prefer: rules.prefer });
  });

  it('adds rules: a pair replaces the one on the same part, and is left out when another does it already', () => {
    const rules = { pairs: [{ from: 'reg05', to: 'reg03' }], prefer: [{ key: 'platform', value: 'arm' }], pins: {} };
    const next = add_rules(rules, { pairs: [{ from: 'a_reg05', to: 'a_reg03' }, { from: 's1', to: 's2' }], prefer: [{ key: 'platform', value: 'x86' }] });
    expect(next.pairs).toEqual([{ from: 'reg05', to: 'reg03' }, { from: 's1', to: 's2' }]);
    expect(next.prefer).toEqual([{ key: 'platform', value: 'x86' }]);
  });
});
