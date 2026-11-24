// cd webapp && npm test -- Trends
import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TrendsReport, TrendsTiles } from '../Trends';
import { trendsOf } from '../model';
import { generate } from '../generate';

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

  it('show nothing for projects whose metrics say nothing of groups', () => {
    const plain = trendsOf(points, {});
    const { container } = render(<><TrendsReport points={points} trends={plain}/><TrendsTiles points={points} trends={plain}/></>);
    expect(container).toBeEmptyDOMElement();
  });
});
