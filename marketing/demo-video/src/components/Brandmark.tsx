import React from 'react';
import {staticFile} from 'remotion';

// The real penguin-in-globe brandmark, copied from public/brandmark.svg and
// public/brandmark-white.svg — unmodified.
export const Brandmark: React.FC<{
  size?: number;
  variant?: 'navy' | 'white';
}> = ({size = 50, variant = 'white'}) => (
  <img
    src={staticFile(variant === 'white' ? 'brandmark-white.svg' : 'brandmark.svg')}
    width={size}
    height={size}
    alt=""
    style={{display: 'block', flexShrink: 0}}
  />
);
