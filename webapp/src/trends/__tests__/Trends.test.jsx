// cd webapp && npm test -- Trends
import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TrendsReport, TrendsTiles } from '../Trends';
import { trendsOf } from '../model';
import { generate, TEST_DEFINITIONS } from '../generate';

const { points, definitions, reports } = generate({ commits: 12, tests: 300, benchmarks: 24 });
const trends = trendsOf(points, definitions);

describe('the trends', () => {
  it('show the headline numbers', () => {
    render(<TrendsTiles points={points} trends={trends}/>);
    expect(screen.getByText('Tests')).toBeInTheDocument();
    expect(screen.getByText('Tests failing')).toBeInTheDocument();
    expect(screen.getByText('Benchmarks')).toBeInTheDocument();
  });

  it('read the test reports only when asked', async () => {
    const asked = [];
    const loadTests = async point => { asked.push(point.id); return [{ name: 'junit.xml', tests: reports[points.indexOf(point)] }]; };
    render(<TrendsReport points={points} trends={trends} loadTests={loadTests}/>);
    expect(screen.getByRole('heading', { name: 'Tests' })).toBeInTheDocument();
    expect(screen.getByText(/benchmarks?$/, { selector: 'strong' })).toBeInTheDocument();
    expect(asked).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Read the test reports of 12 commits' }));
    expect(await screen.findByRole('button', { name: /Failing now/ })).toBeInTheDocument();
    expect(asked).toHaveLength(12);
  });

  it('say when the same tests ran in several configurations', () => {
    // the demo's: each suite in a default and a strict mode
    const metrics = (tests, failed) => ({ tests, passed: tests - failed, failed, errors: 0, skipped: 0, flaky: 0, test_time: 1 });
    const point = (id, failed) => ({ id, label: id, runs: [
      { name: 'codec', configuration: 'default', metrics: metrics(300, failed) }, { name: 'maps', configuration: 'default', metrics: metrics(309, 0) },
      { name: 'codec', configuration: 'strict', metrics: metrics(300, 2 * failed) }, { name: 'maps', configuration: 'strict', metrics: metrics(309, 0) },
    ] });
    const modes = [point('a', 0), point('b', 5)];
    const modes_trends = trendsOf(modes, TEST_DEFINITIONS);
    const { unmount } = render(<TrendsTiles points={modes} trends={modes_trends}/>);
    expect(screen.getByText('609 × 2')).toBeInTheDocument();
    expect(screen.getByText('in 2 configurations · unchanged over 2 commits')).toBeInTheDocument();
    expect(screen.getByText('5 in default · 10 in strict')).toBeInTheDocument();
    expect(screen.getByText('609 × 2').closest('.qa-trends-tile')).toHaveAttribute('title', expect.stringContaining('1,218 in all'));
    unmount();
    render(<TrendsReport points={modes} trends={modes_trends}/>);
    expect(screen.getByText(/609 × 2 configurations: default, strict/)).toBeInTheDocument();
    expect(screen.getByText('15 failing (5 in default · 10 in strict)')).toBeInTheDocument();
  });

  it('show nothing for projects whose metrics say nothing of groups', () => {
    const plain = trendsOf(points, {});
    const { container } = render(<><TrendsReport points={points} trends={plain}/><TrendsTiles points={points} trends={plain}/></>);
    expect(container).toBeEmptyDOMElement();
  });
});
