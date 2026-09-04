import React from 'react';
import {Composition} from 'remotion';
import {loadFont} from '@remotion/google-fonts/Inter';
import './styles/cvsprings.css';
import {DemoVideo, TOTAL_DURATION} from './Video';
import {VIDEO_WIDTH, VIDEO_HEIGHT, FPS} from './theme';

// The real app loads Inter from Google Fonts at runtime (public/app.html);
// bundling it here keeps the render deterministic and network-independent.
loadFont('normal', {weights: ['400', '500', '600', '700', '800']});

import {BrandScene, DURATION as D0} from './scenes/00Brand';
import {UploadScene, DURATION as D1} from './scenes/01Upload';
import {CriteriaScene, DURATION as D2} from './scenes/02Criteria';
import {ScoringScene, DURATION as D3} from './scenes/03Scoring';
import {BreakdownScene, DURATION as D4} from './scenes/04Breakdown';
import {AuditBiasScene, DURATION as D5} from './scenes/05AuditBias';
import {ReportExportScene, DURATION as D6} from './scenes/06ReportExport';

// Registers the full video ("Demo" — this is what `npm run render` renders)
// plus one composition per scene, each independently previewable/renderable
// in Remotion Studio without scrubbing through the whole timeline.
export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="Demo"
        component={DemoVideo}
        durationInFrames={TOTAL_DURATION}
        fps={FPS}
        width={VIDEO_WIDTH}
        height={VIDEO_HEIGHT}
      />
      <Composition
        id="00-Brand"
        component={BrandScene}
        durationInFrames={D0}
        fps={FPS}
        width={VIDEO_WIDTH}
        height={VIDEO_HEIGHT}
      />
      <Composition
        id="01-Upload"
        component={UploadScene}
        durationInFrames={D1}
        fps={FPS}
        width={VIDEO_WIDTH}
        height={VIDEO_HEIGHT}
      />
      <Composition
        id="02-Criteria"
        component={CriteriaScene}
        durationInFrames={D2}
        fps={FPS}
        width={VIDEO_WIDTH}
        height={VIDEO_HEIGHT}
      />
      <Composition
        id="03-Scoring"
        component={ScoringScene}
        durationInFrames={D3}
        fps={FPS}
        width={VIDEO_WIDTH}
        height={VIDEO_HEIGHT}
      />
      <Composition
        id="04-Breakdown"
        component={BreakdownScene}
        durationInFrames={D4}
        fps={FPS}
        width={VIDEO_WIDTH}
        height={VIDEO_HEIGHT}
      />
      <Composition
        id="05-AuditBias"
        component={AuditBiasScene}
        durationInFrames={D5}
        fps={FPS}
        width={VIDEO_WIDTH}
        height={VIDEO_HEIGHT}
      />
      <Composition
        id="06-ReportExport"
        component={ReportExportScene}
        durationInFrames={D6}
        fps={FPS}
        width={VIDEO_WIDTH}
        height={VIDEO_HEIGHT}
      />
    </>
  );
};
