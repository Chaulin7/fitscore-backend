import React from 'react';
import {AbsoluteFill, interpolate, useCurrentFrame} from 'remotion';
import {Brandmark} from './Brandmark';

// The brand card that opens and closes the video — one component so the two
// bookends are identical.
export const LogoCard: React.FC<{
  durationInFrames: number;
  fadeInFrames?: number;
}> = ({durationInFrames, fadeInFrames = 0}) => {
  const frame = useCurrentFrame();
  const scale = interpolate(frame, [0, durationInFrames], [1, 1.03], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const markOpacity = interpolate(frame, [0, 20], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const cardOpacity = fadeInFrames
    ? interpolate(frame, [0, fadeInFrames], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})
    : 1;

  return (
    <AbsoluteFill
      style={{
        background: 'linear-gradient(135deg, #0a1f3d 0%, #0f2847 60%, #153360 100%)',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: cardOpacity,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 20,
          transform: `scale(${scale})`,
          opacity: markOpacity,
        }}
      >
        <Brandmark size={140} variant="white" />
        <div
          style={{
            fontFamily: 'Inter, sans-serif',
            fontWeight: 800,
            fontSize: 56,
            letterSpacing: '-0.02em',
            color: '#ffffff',
          }}
        >
          CV<span style={{color: '#7dd3fc'}}>springs</span>
        </div>
      </div>
    </AbsoluteFill>
  );
};
