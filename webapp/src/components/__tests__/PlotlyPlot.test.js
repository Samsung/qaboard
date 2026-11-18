import { vi } from 'vitest';
vi.mock('plotly.js/dist/plotly.min.js', () => ({ default: {} }));
const { upgradeFigure, plotConfig } = await import('../PlotlyPlot');

test('upgrades plotly.js@2 titles in-place', () => {
  const layout = {
    title: "main",
    xaxis: { title: "x", titlefont: { size: 12 } },
    yaxis2: { title: { text: "already" } },
    scene: { zaxis: { title: "z" } },
  };
  const data = [{ marker: { colorbar: { title: "c" } } }];
  upgradeFigure(data, layout);
  expect(layout).toEqual({
    title: { text: "main" },
    xaxis: { title: { text: "x", font: { size: 12 } } },
    yaxis2: { title: { text: "already" } },
    scene: { zaxis: { title: { text: "z" } } },
  });
  expect(data[0].marker.colorbar.title).toEqual({ text: "c" });
  // idempotent
  upgradeFigure(data, layout);
  expect(layout.title).toEqual({ text: "main" });
});

test('upgrades Mapbox traces to their plotly.js@4 MapLibre equivalents', () => {
  const layout = { mapbox: { zoom: 3 }, mapbox2: { zoom: 5 } };
  const data = [{ type: 'scattermapbox', lat: [1] }, { type: 'densitymapbox', subplot: 'mapbox2' }, { type: 'scatter' }];
  upgradeFigure(data, layout);
  expect(data.map(t => [t.type, t.subplot])).toEqual([['scattermap', 'map'], ['densitymap', 'map2'], ['scatter', undefined]]);
  expect(layout).toEqual({ map: { zoom: 3 }, map2: { zoom: 5 } });
  // idempotent
  upgradeFigure(data, layout);
  expect(layout).toEqual({ map: { zoom: 3 }, map2: { zoom: 5 } });
});

test('hides the "Upload to Cloud" button unless asked', () => {
  expect(plotConfig(undefined)).toEqual({ showSendToCloud: false });
  expect(plotConfig({ responsive: true })).toEqual({ showSendToCloud: false, responsive: true });
});
