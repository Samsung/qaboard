/**
 * The Plotly viewer: plots overlaid on their reference's (side_by_side: false) are named and colored like the sides compared.
 * Run with: cd webapp && npm test -- plotlyViewer
 */
import { screen } from '@testing-library/react';

import PlotlyViewer from '../plotly';
import { side_color } from '../../sideColors';
import { renderWithProviders } from '../../test-utils';

// Plotly doesn't run in jsdom: we only check what would be plotted
vi.mock('../../components/Plot', () => ({
  default: ({ data }) => <div data-testid="plot" data-traces={data.map(t => `${t.name} ${t.line.color}`).join(',')}/>,
}));

const figure = { data: [{ type: 'scatter', name: 'p99', x: [1], y: [2] }], layout: {} };

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(figure), { headers: { 'Content-Type': 'application/json' } })));
});
afterEach(() => vi.unstubAllGlobals());

const render = props => renderWithProviders(<PlotlyViewer path="plot.plotly.json" side_by_side={false} output_new={{ output_dir_url: '/s/new' }} output_ref={{ output_dir_url: '/s/ref' }} {...props}/>);


describe('PlotlyViewer', () => {
  it("overlays the reference in its color, with the page's names", async () => {
    render();
    expect(await screen.findByTestId('plot')).toHaveAttribute('data-traces', 'reference | p99 #9752fedd,new | p99 #2d72d2dd');
  });

  it('uses the names and colors of what the commit page compares', async () => {
    render({ labels: { new: 'ISP v2', reference: 'v1.4', colors: { new: side_color(0), reference: side_color(2) } } });
    expect(await screen.findByTestId('plot')).toHaveAttribute('data-traces', 'v1.4 | p99 #cf0494dd,ISP v2 | p99 #2d72d2dd');
  });

  it("runs figures saved as HTML sandboxed, outside of the app's origin", () => {
    render({ path: 'plot.plotly.html' });
    for (const side of ['new', 'reference']) {
      const sandbox = screen.getByTitle(side).getAttribute('sandbox').split(' ');
      expect(sandbox).toContain('allow-scripts');
      expect(sandbox).not.toContain('allow-same-origin');
    }
  });
});
