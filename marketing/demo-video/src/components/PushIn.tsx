import React from 'react';
import {Easing, interpolate, useCurrentFrame} from 'remotion';

// A slow, restrained scale push-in over the given duration. Sine ease-in-out
// so it starts and settles like a camera move rather than a linear zoom —
// no spring, so no bounce.
export const PushIn: React.FC<{
  durationInFrames: number;
  fromScale?: number;
  toScale?: number;
  children: React.ReactNode;
}> = ({durationInFrames, fromScale = 1, toScale = 1.05, children}) => {
  const frame = useCurrentFrame();
  const scale = interpolate(frame, [0, durationInFrames], [fromScale, toScale], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.inOut(Easing.sin),
  });

  return (
    <div style={{width: '100%', height: '100%', transform: `scale(${scale})`}}>
      {children}
    </div>
  );
};
