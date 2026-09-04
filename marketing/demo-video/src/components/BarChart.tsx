import React from 'react';
import {interpolate, useCurrentFrame} from 'remotion';

// Reproduces the real barChart() SVG generator from public/bias-report.html
// (horizontal bars, same geometry constants), animated bar-by-bar on reveal.
export const BarChart: React.FC<{
  rows: {label: string; value: number; valueText: string}[];
  max: number;
  fillColor: string;
  revealStartFrame: number;
  rowStagger?: number;
}> = ({rows, max, fillColor, revealStartFrame, rowStagger = 10}) => {
  const frame = useCurrentFrame();
  const barH = 16;
  const gap = 6;
  const labelW = 130;
  const valueW = 140;
  const width = 900;
  const chartW = width - labelW - valueW;
  const height = rows.length * (barH + gap);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" style={{maxWidth: width, display: 'block'}}>
      {rows.map((r, i) => {
        const y = i * (barH + gap);
        const start = revealStartFrame + i * rowStagger;
        const t = interpolate(frame, [start, start + 20], [0, 1], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        });
        const w = max > 0 ? (r.value / max) * chartW * t : 0;
        return (
          <g key={r.label}>
            <text
              x={labelW - 8}
              y={y + barH - 4}
              textAnchor="end"
              fontSize={13}
              fontFamily="Inter, sans-serif"
              fill="#9ca3af"
            >
              {r.label}
            </text>
            <rect x={labelW} y={y} width={chartW} height={barH} rx={3} fill="#f3f4f6" />
            {w > 0 ? <rect x={labelW} y={y} width={Math.max(w, 2)} height={barH} rx={3} fill={fillColor} /> : null}
            <text
              x={labelW + chartW + 8}
              y={y + barH - 4}
              fontSize={13}
              fontFamily="Inter, sans-serif"
              fill="#6b7280"
              opacity={t}
            >
              {r.valueText}
            </text>
          </g>
        );
      })}
    </svg>
  );
};
