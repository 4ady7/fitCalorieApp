import { useState } from 'react';
import { formatNumber } from '@shared/nutrients.js';
import { formatMeasure } from '@shared/analytics.js';

const SERIES_COLOR = {
  current: 'var(--accent)',
  previous: 'var(--honey)',
  intake: 'var(--accent)',
  achievement: 'var(--accent)',
};

function tickLabel(value, unit) {
  if (unit === '%') return `${Math.round(value)}%`;
  if (unit === 'ml' && Math.abs(value) >= 100) return Math.round(value).toLocaleString('en-GB');
  return formatNumber(value, unit === 'ml' ? 'g' : unit);
}

function pointLabel(value, unit, partial) {
  if (value == null) return 'Not recorded';
  const text = formatMeasure(value, unit);
  return partial ? `${text} (partial)` : text;
}

export function AnalyticsChart({ chart, title }) {
  const [active, setActive] = useState(null);
  if (!chart?.categories?.length) return <p className="hint">Nothing to chart for this period.</p>;
  const numbers = [];
  for (const series of chart.series) {
    for (const value of series.values) if (typeof value === 'number') numbers.push(value);
  }
  for (const guide of chart.guides || []) if (typeof guide.value === 'number') numbers.push(guide.value);
  if (!numbers.length) {
    return <p className="empty">No recorded intake in this period. Days without a log are not drawn as zero.</p>;
  }

  const width = 640;
  const height = 268;
  const pad = { l: 56, r: 16, t: 16, b: 42 };
  const innerW = width - pad.l - pad.r;
  const innerH = height - pad.t - pad.b;
  const peak = Math.max(...numbers, chart.unit === '%' ? 100 : 0, 0);
  const max = peak <= 0 ? 1 : peak * 1.12;
  const yOf = (value) => pad.t + innerH - (value / max) * innerH;
  const baseline = yOf(0);
  const group = innerW / chart.categories.length;
  const ticks = [0, max / 2, max];
  const seriesCount = chart.series.length;
  const barGap = Math.min(10, group * 0.12);
  const barWidth = Math.max(3, (group - barGap * 2) / seriesCount - (seriesCount > 1 ? 3 : 0));

  function barX(seriesIndex, index) {
    return pad.l + group * index + barGap + seriesIndex * (barWidth + (seriesCount > 1 ? 3 : 0));
  }

  function categoryX(index) {
    return pad.l + group * index + group / 2;
  }

  function linePath(values) {
    let path = '';
    let open = false;
    values.forEach((value, index) => {
      if (typeof value !== 'number') {
        open = false;
        return;
      }
      path += `${open ? 'L' : 'M'}${categoryX(index)},${yOf(value)} `;
      open = true;
    });
    return path;
  }

  const guideLine = (chart.guides || []).filter((guide) => guide.index == null);
  const guideMarks = (chart.guides || []).filter((guide) => guide.index != null);

  return (
    <figure className="chart-card">
      {title && <figcaption>{title}</figcaption>}
      <div className="chart-frame">
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title || 'Nutrition chart'}>
          {ticks.map((tick) => (
            <g key={tick}>
              <line x1={pad.l} x2={width - pad.r} y1={yOf(tick)} y2={yOf(tick)} className="chart-grid" />
              <text x={pad.l - 8} y={yOf(tick) + 4} className="chart-tick" textAnchor="end">{tickLabel(tick, chart.unit)}</text>
            </g>
          ))}
          {guideLine.map((guide) => (
            <line key={`guide-${guide.value}`} x1={pad.l} x2={width - pad.r} y1={yOf(guide.value)} y2={yOf(guide.value)} className="chart-guide" />
          ))}
          {chart.type === 'lines' && chart.series.map((series) => (
            <g key={series.id}>
              <path d={linePath(series.values)} fill="none" stroke={SERIES_COLOR[series.id] || 'var(--accent)'} strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" />
              {series.values.map((value, index) => (
                typeof value === 'number' ? (
                  <circle
                    key={`${series.id}-${index}`}
                    cx={categoryX(index)}
                    cy={yOf(value)}
                    r={active === index ? 4.5 : 3}
                    fill={SERIES_COLOR[series.id] || 'var(--accent)'}
                    opacity={series.partials?.[index] ? 0.55 : 1}
                  />
                ) : null
              ))}
            </g>
          ))}
          {chart.type === 'bars' && chart.series.map((series, seriesIndex) => (
            <g key={series.id}>
              {series.values.map((value, index) => {
                if (typeof value !== 'number') return null;
                const top = yOf(value);
                return (
                  <rect
                    key={`${series.id}-${index}`}
                    x={barX(seriesIndex, index)}
                    y={top}
                    width={barWidth}
                    height={Math.max(1.5, baseline - top)}
                    rx="4"
                    fill={SERIES_COLOR[series.id] || 'var(--accent)'}
                    opacity={series.partials?.[index] ? 0.45 : active === index ? 1 : 0.9}
                  />
                );
              })}
            </g>
          ))}
          {guideMarks.map((guide) => (
            <line
              key={`mark-${guide.index}-${guide.value}`}
              x1={pad.l + group * guide.index + 4}
              x2={pad.l + group * (guide.index + 1) - 4}
              y1={yOf(guide.value)}
              y2={yOf(guide.value)}
              className="chart-guide"
            />
          ))}
          {chart.categories.map((category, index) => (
            <text key={category + index} x={categoryX(index)} y={height - 16} className="chart-label" textAnchor="middle">
              {category}
            </text>
          ))}
          {chart.categories.map((category, index) => (
            <rect
              key={`hit-${category}-${index}`}
              x={pad.l + group * index}
              y={pad.t}
              width={group}
              height={innerH}
              fill="transparent"
              onPointerEnter={() => setActive(index)}
              onPointerLeave={() => setActive(null)}
            >
              <title>
                {category}
                {chart.series.map((series) => `\n${series.label}: ${pointLabel(series.values[index], chart.unit, series.partials?.[index])}`).join('')}
              </title>
            </rect>
          ))}
        </svg>
        {active != null && (
          <div className="chart-tip" style={{ left: `${((pad.l + group * active + group / 2) / width) * 100}%` }}>
            <strong>{chart.categories[active]}</strong>
            {chart.series.map((series) => (
              <p key={series.id}>
                <i style={{ background: SERIES_COLOR[series.id] || 'var(--accent)' }} />
                {series.label}: {pointLabel(series.values[active], chart.unit, series.partials?.[active])}
              </p>
            ))}
            {(chart.guides || []).filter((guide) => guide.index == null || guide.index === active).map((guide) => (
              <p key={`${guide.label}-${guide.value}`}>{guide.label}: {formatMeasure(guide.value, chart.unit)}</p>
            ))}
          </div>
        )}
      </div>
      <div className="chart-legend">
        {chart.series.map((series) => (
          <span key={series.id}><i style={{ background: SERIES_COLOR[series.id] || 'var(--accent)' }} />{series.label}</span>
        ))}
        {(chart.guides || []).length > 0 && <span><i className="guide-swatch" />Target</span>}
        <span className="hint">Gaps are unlogged or unstated. They are not zeros.</span>
      </div>
    </figure>
  );
}
