import React from 'react';
import {interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {AppShell} from '../components/AppShell';
import {Caption} from '../components/Caption';
import {fadeUpStyle} from '../utils/animation';
import {RANKED, ROLE, TOTAL_CV_COUNT, BATCH_AVG_SCORE} from '../data/candidates';

export const DURATION = 420; // 14s @ 30fps

const ROW_START = 80;
const ROW_STAGGER = 9;

// The caption promises identical output on identical input. This is the
// table re-running: fade out, then the same rows with the same numbers.
const DIM_START = 240;
const RERUN_AT = 262;
const RERUN_STAGGER = 5;

const rankClass = (i: number) => (i === 0 ? 'r1' : i === 1 ? 'r2' : i === 2 ? 'r3' : 'rn');
const pillClass = (s: number) => (s >= 70 ? 'pill-hi' : s >= 50 ? 'pill-med' : 'pill-lo');

export const ScoringScene: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const shortlisted = RANKED.filter((c) => c.overall >= 70).length;
  const top = RANKED[0];

  const rowStyle = (i: number): React.CSSProperties => {
    if (frame < RERUN_AT) {
      const s = fadeUpStyle(frame, ROW_START + i * ROW_STAGGER, fps);
      const dim = interpolate(frame, [DIM_START, RERUN_AT], [1, 0], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      });
      return {...s, opacity: Number(s.opacity ?? 1) * dim};
    }
    return fadeUpStyle(frame, RERUN_AT + i * RERUN_STAGGER, fps);
  };

  return (
    <AppShell activeTab="analyzer">
      <div style={{maxWidth: 1500, margin: '0 auto'}}>
        <div className="card">
          <div className="card-head">
            <span className="card-title">
              Ranked Results {TOTAL_CV_COUNT} candidates / {ROLE}
            </span>
            <div style={{display: 'flex', alignItems: 'center', gap: 14}}>
              <span style={{fontSize: 12, fontWeight: 600, color: '#0f2847', ...fadeUpStyle(frame, RERUN_AT, fps)}}>
                ✓ Run 2 · identical output
              </span>
              <span style={{fontSize: 12, color: '#6b7280'}}>Showing top {RANKED.length}</span>
            </div>
          </div>

          <div className="batch-summary" style={{padding: '18px 20px 0'}}>
            {[
              {val: String(TOTAL_CV_COUNT), label: 'CVs Analysed', sub: ''},
              {val: String(BATCH_AVG_SCORE), label: 'Avg Score', sub: 'out of 100'},
              {val: String(shortlisted), label: 'Above threshold', sub: 'score ≥ 70'},
              {val: top.name, label: 'Top Candidate', sub: ''},
            ].map((card, i) => (
              <div className="bs-card" key={card.label} style={fadeUpStyle(frame, 10 + i * 10, fps)}>
                <div className="bs-val">{card.val}</div>
                <div className="bs-label">{card.label}</div>
                {card.sub ? <div className="bs-sub">{card.sub}</div> : null}
              </div>
            ))}
          </div>

          <div className="card-body" style={{overflowX: 'auto'}}>
            <table className="lb">
              <thead>
                <tr>
                  <th style={{width: 44}}>#</th>
                  <th>Candidate</th>
                  <th>Overall</th>
                  <th>KW</th>
                  <th>SK</th>
                  <th>EX</th>
                  <th>ED</th>
                  <th>Decision</th>
                </tr>
              </thead>
              <tbody>
                {RANKED.map((c, i) => {
                  return (
                    <tr key={c.id} style={rowStyle(i)}>
                      <td
                        style={{
                          borderLeft: `3px solid ${c.overall >= 70 ? '#16a34a' : c.overall >= 50 ? '#d97706' : '#dc2626'}`,
                        }}
                      >
                        <span className={`rank-badge ${rankClass(i)}`}>{i + 1}</span>
                      </td>
                      <td style={{fontWeight: 600, color: '#111827'}}>{c.name}</td>
                      <td>
                        <span className={`score-pill ${pillClass(c.overall)}`}>{c.overall}</span>
                      </td>
                      <td>{c.scores.keywords}</td>
                      <td>{c.scores.skills}</td>
                      <td>{c.scores.experience}</td>
                      <td>{c.scores.education}</td>
                      <td>
                        <select className="dec-sel" defaultValue="">
                          <option value="">&mdash; Decision &mdash;</option>
                          <option value="shortlist">Shortlist</option>
                          <option value="hold">On Hold</option>
                          <option value="reject">Reject</option>
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <Caption
        text="Deterministic scoring. Same input, same output, every time."
        durationInFrames={DURATION}
      />
    </AppShell>
  );
};
