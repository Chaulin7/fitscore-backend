import React from 'react';
import {interpolate, useCurrentFrame} from 'remotion';

// Reproduces the real ringBox() function (public/app.html:3613) — same SVG
// geometry, same stroke-dasharray technique — but driven by the Remotion
// frame instead of a CSS transition, since renders must be frame-deterministic.
export const RingScore: React.FC<{
  label: string;
  value: number;
  isOverall?: boolean;
  color: string;
  fillStartFrame: number;
  fillDurationInFrames?: number;
}> = ({label, value, isOverall, color, fillStartFrame, fillDurationInFrames = 30}) => {
  const frame = useCurrentFrame();
  const r = 28;
  const circ = 2 * Math.PI * r;
  const progress = interpolate(
    frame,
    [fillStartFrame, fillStartFrame + fillDurationInFrames],
    [0, value],
    {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'},
  );
  const textColor = isOverall ? '#fff' : color;

  return (
    <div className={`score-box${isOverall ? ' overall' : ''}`}>
      <div className="s-label">{label}</div>
      <svg className="ring-svg" width={70} height={70} viewBox="0 0 70 70">
        <circle
          className="ring-bg"
          cx={35}
          cy={35}
          r={r}
          stroke={isOverall ? 'rgba(255,255,255,0.12)' : undefined}
        />
        <circle
          className="ring-fill"
          cx={35}
          cy={35}
          r={r}
          stroke={color}
          transform="rotate(-90 35 35)"
          style={{
            strokeDasharray: circ,
            strokeDashoffset: circ * (1 - progress / 100),
          }}
        />
        <text
          x={35}
          y={35}
          textAnchor="middle"
          dominantBaseline="central"
          fill={textColor}
          fontFamily="Inter"
          fontWeight={800}
          fontSize={17}
        >
          {Math.round(progress)}
        </text>
      </svg>
    </div>
  );
};
