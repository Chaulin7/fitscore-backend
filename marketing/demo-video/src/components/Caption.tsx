import React from 'react';
import {interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';

// Bottom-third burned-in caption. Restrained: a single soft fade, no slide,
// no bounce. Held for the caller's full duration so it can be read twice.
export const Caption: React.FC<{text: string; durationInFrames: number}> = ({
  text,
  durationInFrames,
}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const fadeIn = spring({frame, fps, config: {damping: 200}, durationInFrames: 20});
  const fadeOut = interpolate(
    frame,
    [durationInFrames - 15, durationInFrames],
    [1, 0],
    {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'},
  );
  const opacity = Math.min(fadeIn, fadeOut);

  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 90,
        display: 'flex',
        justifyContent: 'center',
        opacity,
      }}
    >
      <div
        style={{
          background: 'rgba(10, 31, 61, 0.88)',
          color: '#ffffff',
          fontFamily: 'Inter, sans-serif',
          fontWeight: 600,
          fontSize: 34,
          letterSpacing: '-0.01em',
          padding: '20px 44px',
          borderRadius: 12,
          maxWidth: 1400,
          textAlign: 'center',
          boxShadow: '0 12px 40px rgba(0,0,0,0.35)',
          border: `1px solid rgba(125, 211, 252, 0.25)`,
        }}
      >
        {text}
      </div>
    </div>
  );
};
