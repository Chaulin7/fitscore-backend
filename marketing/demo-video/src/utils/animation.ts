import type {CSSProperties} from 'react';
import {Easing, interpolate, spring} from 'remotion';

// Shared restrained reveal: fade + small rise, spring-eased, no bounce
// (high damping). Used for staggered rows/cards across every scene so the
// whole video reads as one motion language.
export const fadeUpStyle = (
  frame: number,
  startFrame: number,
  fps: number,
): CSSProperties => {
  const localFrame = frame - startFrame;
  if (localFrame < 0) {
    return {opacity: 0, transform: 'translateY(14px)'};
  }
  const progress = spring({
    frame: localFrame,
    fps,
    config: {damping: 200, mass: 0.6},
    durationInFrames: 18,
  });
  return {
    opacity: progress,
    transform: `translateY(${14 * (1 - progress)}px)`,
  };
};

// "This line, now this one": a navy tint and left rule. Eased rise, a short
// plateau, then a long soft settle — long enough that neighbouring rows
// overlap and the emphasis moves down the list as a wave rather than a
// spotlight hopping row to row. Shared by the hero breakdown rows and the
// report's assurance line so they read as the same gesture.
export const highlightSweep = (frame: number, startFrame: number): CSSProperties => {
  const rise = interpolate(frame, [startFrame - 6, startFrame + 10], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.cubic),
  });
  const settle = interpolate(frame, [startFrame + 14, startFrame + 80], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.inOut(Easing.quad),
  });
  const t = Math.min(rise, settle);
  return {
    background: `rgba(15, 40, 71, ${0.06 * t})`,
    borderLeft: `3px solid rgba(15, 40, 71, ${t})`,
    paddingLeft: 8,
  };
};

// Rows that are pre-drawn faint and brought up to full as the sweep reaches
// them. Same spring as fadeUpStyle so reveal and rise read as one motion.
export const ghostReveal = (
  frame: number,
  startFrame: number,
  fps: number,
  ghost = 0.15,
): CSSProperties => {
  const localFrame = frame - startFrame;
  if (localFrame < 0) {
    return {opacity: ghost};
  }
  const progress = spring({
    frame: localFrame,
    fps,
    config: {damping: 200, mass: 0.6},
    durationInFrames: 18,
  });
  return {opacity: ghost + (1 - ghost) * progress};
};
