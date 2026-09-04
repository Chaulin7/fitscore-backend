import React from 'react';
import {LogoCard} from '../components/LogoCard';

export const DURATION = 60; // 2s @ 30fps — opening brand beat, bookends the closing card.

export const BrandScene: React.FC = () => <LogoCard durationInFrames={DURATION} />;
