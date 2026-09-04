import React from 'react';
import {AbsoluteFill, Easing, Sequence, interpolate, useCurrentFrame} from 'remotion';
import {Caption} from '../components/Caption';
import {Brandmark} from '../components/Brandmark';
import {LogoCard} from '../components/LogoCard';
import {fadeUpStyle, highlightSweep} from '../utils/animation';
import {HERO_CANDIDATE, ROLE} from '../data/candidates';

export const REPORT_DURATION = 210; // 7s
export const LOGO_DURATION = 180; // 6s
export const DURATION = REPORT_DURATION + LOGO_DURATION; // 13s @ 30fps

const METHODOLOGY = [
  'Scoring performed by a deterministic, rule-based matching engine — not a machine-learning model.',
  'No CV content is sent to any third-party AI service. No AI subprocessor is involved.',
  'Output is advisory and supports human review; CVsprings does not make automated decisions.',
  'Scoring is fully reproducible: the same CV and job description always produce the same scores and the same supporting evidence.',
];

const ASSURANCE =
  'No language model was used in the assessment of this candidate. ' +
  'Re-running this analysis on identical inputs produces an identical result.';

const REPORT_ID = 'a13f7e2c-9b04-4c58';
const RULESET = '1.3.0';
const ASSESSED = '2026-08-11T09:47:02Z';
const GENERATED = '2026-09-03T10:12:44Z';

const ASSURANCE_SWEEP = 95;

// The provenance footer is set at PDF-footer size, faithful to the real
// report; the push-in, anchored at the card's bottom edge, is what makes it
// readable at video scale.
const PUSH_START = 120;
const PUSH_SCALE = 1.3;
const FADE_OUT_FRAMES = 12;

const ReportPanel: React.FC = () => {
  const frame = useCurrentFrame();
  const scale = interpolate(frame, [PUSH_START, REPORT_DURATION], [1, PUSH_SCALE], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.inOut(Easing.ease),
  });
  const opacity = interpolate(frame, [REPORT_DURATION - FADE_OUT_FRAMES, REPORT_DURATION], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill style={{background: '#f0f2f5', alignItems: 'center', justifyContent: 'center', opacity}}>
      <div style={{transform: `scale(${scale})`, transformOrigin: '50% 100%'}}>
        <div
          style={{
            width: 1180,
            background: '#ffffff',
            borderRadius: 10,
            border: '1px solid #e5e7eb',
            boxShadow: '0 20px 60px rgba(0,0,0,0.12)',
            padding: '48px 56px',
            fontFamily: 'Inter, sans-serif',
            ...fadeUpStyle(frame, 5, 30),
          }}
        >
          <div style={{display: 'flex', alignItems: 'center', gap: 12, marginBottom: 28}}>
            <Brandmark size={36} variant="navy" />
            <div>
              <div style={{fontWeight: 800, fontSize: 16, color: '#0a1f3d', letterSpacing: '-0.3px'}}>
                CV<span style={{color: '#2563a6'}}>springs</span> Candidate Report
              </div>
              <div style={{fontSize: 13, color: '#6b7280'}}>
                {HERO_CANDIDATE.name} · {ROLE}
              </div>
            </div>
            <div style={{marginLeft: 'auto', textAlign: 'right'}}>
              <div style={{fontSize: 26, fontWeight: 800, color: '#0a1f3d'}}>{HERO_CANDIDATE.overall}</div>
              <div style={{fontSize: 10, color: '#9ca3af', letterSpacing: '.08em', textTransform: 'uppercase'}}>
                Overall
              </div>
            </div>
          </div>

          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '.09em',
              textTransform: 'uppercase',
              color: '#0a1f3d',
              marginBottom: 10,
              ...fadeUpStyle(frame, 30, 30),
            }}
          >
            Methodology &amp; compliance
          </div>
          <ul
            style={{
              margin: 0,
              paddingLeft: 20,
              color: '#374151',
              fontSize: 14,
              lineHeight: 1.8,
              ...fadeUpStyle(frame, 40, 30),
            }}
          >
            {METHODOLOGY.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>

          <div
            style={{
              marginTop: 22,
              padding: '12px 16px',
              background: '#f8faff',
              border: '1px solid #dde4f7',
              borderRadius: 8,
              ...fadeUpStyle(frame, 80, 30),
            }}
          >
            <div style={{fontSize: 13, color: '#0f2847', lineHeight: 1.6, ...highlightSweep(frame, ASSURANCE_SWEEP)}}>
              {ASSURANCE}
            </div>
          </div>

          <div
            style={{
              marginTop: 26,
              paddingTop: 16,
              borderTop: '1px solid #e5e7eb',
              fontSize: 12,
              color: '#9ca3af',
              lineHeight: 1.6,
              ...fadeUpStyle(frame, 110, 30),
            }}
          >
            <div>
              Report {REPORT_ID} &nbsp;·&nbsp; Engine cvsprings-matcher &nbsp;·&nbsp; Ruleset {RULESET}
            </div>
            <div>
              Assessed {ASSESSED} &nbsp;·&nbsp; Generated {GENERATED} &nbsp;·&nbsp; Generated by CVsprings
            </div>
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

export const ReportExportScene: React.FC = () => {
  return (
    <>
      <Sequence from={0} durationInFrames={REPORT_DURATION}>
        <ReportPanel />
        <Caption text="EU AI Act ready. GDPR by design." durationInFrames={REPORT_DURATION} />
      </Sequence>
      <Sequence from={REPORT_DURATION} durationInFrames={LOGO_DURATION}>
        <LogoCard durationInFrames={LOGO_DURATION} fadeInFrames={15} />
      </Sequence>
    </>
  );
};
