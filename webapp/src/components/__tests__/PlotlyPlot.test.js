import { vi } from 'vitest';
vi.mock('plotly.js/dist/plotly.min.js', () => ({ default: {} }));
const { upgradeFigure } = await import('../PlotlyPlot');

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
