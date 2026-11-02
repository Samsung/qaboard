// Batches with runs on each of the last 30 days, as a small line. Colors follow the theme (App.css tokens).
// Decorative: the cards say when the latest activity was. Hovering gives the total.
const width = 90;
const height = 24;

export const Sparkline = ({ activity, label = "Batches with runs per day, last 30 days" }) => {
  const values = activity ?? [];
  const total = values.reduce((a, b) => a + b, 0);
  const title = total ? `${label}: ${total} in total` : `${label}: none`;
  if (!total)
    return <svg width={width} height={height} aria-hidden="true">
      <title>{title}</title>
      <line x1={0} x2={width} y1={height - 1.5} y2={height - 1.5} stroke="var(--qa-border)" strokeWidth={1}/>
    </svg>;
  const max = Math.max(...values);
  const step = width / Math.max(values.length - 1, 1);
  const y = n => height - 1.5 - (n / max) * (height - 4);
  const points = values.map((n, i) => `${(i * step).toFixed(1)},${y(n).toFixed(1)}`);
  return <svg width={width} height={height} aria-hidden="true" style={{ overflow: 'visible' }}>
    <title>{title}</title>
    <polygon points={`0,${height} ${points.join(' ')} ${width},${height}`} fill="var(--qa-intent-primary)" fillOpacity={0.15}/>
    <polyline points={points.join(' ')} fill="none" stroke="var(--qa-intent-primary)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round"/>
  </svg>;
};
