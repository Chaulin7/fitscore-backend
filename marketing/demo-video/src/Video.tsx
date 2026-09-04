import React from 'react';
import {AbsoluteFill} from 'remotion';
import {TransitionSeries, linearTiming} from '@remotion/transitions';
import {fade} from '@remotion/transitions/fade';

import {BrandScene, DURATION as D0} from './scenes/00Brand';
import {UploadScene, DURATION as D1} from './scenes/01Upload';
import {CriteriaScene, DURATION as D2} from './scenes/02Criteria';
import {ScoringScene, DURATION as D3} from './scenes/03Scoring';
import {BreakdownScene, DURATION as D4} from './scenes/04Breakdown';
import {AuditBiasScene, DURATION as D5} from './scenes/05AuditBias';
import {ReportExportScene, DURATION as D6} from './scenes/06ReportExport';

// Restrained cross-dissolve between every scene. Bump this to lengthen the
// fades; each transition eats this many frames from the two adjacent scenes'
// combined runtime, so raising it shortens the overall video slightly.
export const TRANSITION_FRAMES = 15;

export const SCENES = [
  {Component: BrandScene, durationInFrames: D0},
  {Component: UploadScene, durationInFrames: D1},
  {Component: CriteriaScene, durationInFrames: D2},
  {Component: ScoringScene, durationInFrames: D3},
  {Component: BreakdownScene, durationInFrames: D4},
  {Component: AuditBiasScene, durationInFrames: D5},
  {Component: ReportExportScene, durationInFrames: D6},
];

export const TOTAL_DURATION =
  SCENES.reduce((sum, s) => sum + s.durationInFrames, 0) -
  (SCENES.length - 1) * TRANSITION_FRAMES;

export const DemoVideo: React.FC = () => {
  return (
    <AbsoluteFill style={{background: '#f0f2f5'}}>
      <TransitionSeries>
        {SCENES.map((scene, i) => (
          <React.Fragment key={i}>
            <TransitionSeries.Sequence durationInFrames={scene.durationInFrames}>
              <scene.Component />
            </TransitionSeries.Sequence>
            {i < SCENES.length - 1 ? (
              <TransitionSeries.Transition
                presentation={fade()}
                timing={linearTiming({durationInFrames: TRANSITION_FRAMES})}
              />
            ) : null}
          </React.Fragment>
        ))}
      </TransitionSeries>
    </AbsoluteFill>
  );
};
