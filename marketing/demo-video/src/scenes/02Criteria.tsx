import React from 'react';
import {interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {AppShell} from '../components/AppShell';
import {Caption} from '../components/Caption';
import {fadeUpStyle} from '../utils/animation';
import {ROLE} from '../data/candidates';

export const DURATION = 330; // 11s @ 30fps

const JD_TEXT = `We're hiring a Senior Backend Engineer to own the core API and data layer behind our platform.

You will design distributed systems, run PostgreSQL at scale, and lead the move to a microservices architecture on Kubernetes. Strong system design instincts and CI/CD discipline are essential — this role sets the technical bar for the team, not just follows it.

What we're looking for:
- 5+ years building production Node.js services
- Deep PostgreSQL experience, including schema design and query performance
- Hands-on Kubernetes, and infrastructure-as-code tools like Terraform
- Comfortable owning API design end to end
- GraphQL experience is a strong plus`;

type WeightDef = {label: string; desc: string; target: number; start: number};

const WEIGHTS: WeightDef[] = [
  {label: 'Keywords', desc: 'Job title & role terms', target: 40, start: 60},
  {label: 'Skills', desc: 'Technical & soft skills', target: 30, start: 110},
  {label: 'Experience', desc: 'Years & seniority level', target: 20, start: 160},
  {label: 'Education', desc: 'Degrees & qualifications', target: 10, start: 210},
];

const COUNT_DURATION = 40;

export const CriteriaScene: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const sumVisible = frame > 262;

  return (
    <AppShell activeTab="analyzer">
      <div style={{maxWidth: 1400, margin: '0 auto'}}>
        <div className="options-row" style={{marginBottom: 18, ...fadeUpStyle(frame, 10, fps)}}>
          <span className="opt-label">Role / Position</span>
          <input className="text-input" readOnly value={ROLE} style={{minWidth: 260}} />
        </div>

        <div className="card" style={fadeUpStyle(frame, 25, fps)}>
          <div className="card-head">
            <span className="card-title">Job Description</span>
          </div>
          <div className="card-body">
            <div
              className="textarea"
              style={{
                minHeight: 260,
                lineHeight: 1.65,
                color: '#111827',
                whiteSpace: 'pre-line',
                opacity: interpolate(frame, [40, 70], [0, 1], {
                  extrapolateLeft: 'clamp',
                  extrapolateRight: 'clamp',
                }),
              }}
            >
              {JD_TEXT}
            </div>
          </div>
        </div>

        <div className="card" style={fadeUpStyle(frame, 55, fps)}>
          <div className="card-head">
            <span className="card-title">Scoring Weights</span>
            <span className={`w-sum${sumVisible ? ' ok' : ''}`}>
              {sumVisible ? 'Total: 100' : ''}
            </span>
          </div>
          <div className="card-body">
            <div className="weights-grid">
              {WEIGHTS.map((w) => {
                const active = frame >= w.start && frame < w.start + COUNT_DURATION + 20;
                const value = Math.round(
                  interpolate(frame, [w.start, w.start + COUNT_DURATION], [0, w.target], {
                    extrapolateLeft: 'clamp',
                    extrapolateRight: 'clamp',
                  }),
                );
                return (
                  <div
                    key={w.label}
                    className={`w-card${active ? ' focus' : ''}`}
                    style={fadeUpStyle(frame, w.start - 8, fps)}
                  >
                    <div className="w-name">{w.label}</div>
                    <div className="w-desc">{w.desc}</div>
                    <div className="w-input" style={{display: 'flex', alignItems: 'center', justifyContent: 'center'}}>
                      {value}
                    </div>
                    <input
                      type="range"
                      className="w-slider"
                      min={0}
                      max={100}
                      value={value}
                      readOnly
                    />
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
      <Caption text="You define the criteria. Explicitly." durationInFrames={DURATION} />
    </AppShell>
  );
};
