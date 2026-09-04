import React from 'react';
import {interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {AppShell} from '../components/AppShell';
import {Caption} from '../components/Caption';
import {BarChart} from '../components/BarChart';
import {fadeUpStyle} from '../utils/animation';
import {AUDIT_RECORDS, ORG_STATS} from '../data/candidates';

export const DURATION = 420; // 14s @ 30fps

const CROSSFADE_AT = 190;
const CROSSFADE_LEN = 24;

const pillClass = (s: number) => (s >= 70 ? 'pill-hi' : s >= 50 ? 'pill-med' : 'pill-lo');

const AuditPanel: React.FC<{frame: number; fps: number}> = ({frame, fps}) => (
  <div style={{maxWidth: 1500, margin: '0 auto'}}>
    <div className="card">
      <div className="card-head">
        <span className="card-title">Audit Log</span>
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: '#0f2847',
            background: '#eef2f9',
            border: '1px solid #dbe3f0',
            borderRadius: 999,
            padding: '3px 10px',
          }}
        >
          Immutable · append-only
        </span>
      </div>
      <div className="card-body" style={{overflowX: 'auto', paddingTop: 0}}>
        <table className="data-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Candidate</th>
              <th>Role</th>
              <th>Overall</th>
              <th>Decision</th>
              <th>Note</th>
              <th>Saved by</th>
            </tr>
          </thead>
          <tbody>
            {AUDIT_RECORDS.map((r, i) => (
              <tr key={`${r.date}-${r.name}`} style={fadeUpStyle(frame, 30 + i * 14, fps)}>
                <td style={{fontSize: 11, color: '#9ca3af', whiteSpace: 'nowrap'}}>{r.date}</td>
                <td style={{fontWeight: 600}}>{r.name}</td>
                <td style={{color: '#6b7280', fontSize: 12}}>{r.role}</td>
                <td>
                  <span className={`score-pill ${pillClass(r.overall)}`}>{r.overall}</span>
                </td>
                <td>{r.decision}</td>
                <td style={{color: '#6b7280'}}>{r.note}</td>
                <td style={{fontSize: 11, color: '#6b7280'}}>{r.reviewer}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  </div>
);

const BiasPanel: React.FC<{frame: number}> = ({frame}) => {
  const local = frame - CROSSFADE_AT;
  const histogram = ORG_STATS.histogram.map((b) => ({label: b.label, value: b.count, valueText: String(b.count)}));
  const histMax = Math.max(...ORG_STATS.histogram.map((b) => b.count), 1);
  const shortlistRate = ORG_STATS.shortlistRate.map((b) => ({
    label: b.label,
    value: b.rate,
    valueText: `${b.rate}% (${b.shortlisted}/${b.total})`,
  }));

  return (
    <div style={{maxWidth: 1200, margin: '0 auto'}}>
      <div className="br-hero" style={fadeUpStyle(local, 0, 30)}>
        <h1>Bias &amp; monitoring</h1>
        <p>
          Scoring consistency computed from your organization&rsquo;s own audit
          data — not a demographic bias audit. CVsprings does not collect
          demographic data.
        </p>
      </div>
      <div className="br-card" style={fadeUpStyle(local, 20, 30)}>
        <div className="br-card-head">
          <span className="br-card-title">Scoring consistency in your organization</span>
        </div>
        <div className="br-card-body">
          <div className="br-role-block">
            <div className="br-role-name">All roles combined</div>
            <div className="br-role-stats">
              {ORG_STATS.records} records · mean {ORG_STATS.mean} · median {ORG_STATS.median}
            </div>
            <div className="br-chart-label">Score distribution (count per band)</div>
            <BarChart rows={histogram} max={histMax} fillColor="#0f2847" revealStartFrame={45} />
            <div className="br-chart-label">Shortlist rate by score band</div>
            <BarChart rows={shortlistRate} max={100} fillColor="#7c3aed" revealStartFrame={95} />
          </div>
        </div>
      </div>
    </div>
  );
};

export const AuditBiasScene: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const auditOpacity = interpolate(frame, [CROSSFADE_AT, CROSSFADE_AT + CROSSFADE_LEN], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const biasOpacity = 1 - auditOpacity;

  return (
    <AppShell activeTab={frame < CROSSFADE_AT + CROSSFADE_LEN / 2 ? 'audit' : 'bias'}>
      <div style={{position: 'relative', height: '100%'}}>
        <div style={{position: 'absolute', inset: 0, opacity: auditOpacity, overflow: 'auto'}}>
          <AuditPanel frame={frame} fps={fps} />
        </div>
        <div style={{position: 'absolute', inset: 0, opacity: biasOpacity, overflow: 'auto'}}>
          <BiasPanel frame={frame} />
        </div>
      </div>
      <Caption
        text="Server-attested audit log. Bias monitoring your DPO can read."
        durationInFrames={DURATION}
      />
    </AppShell>
  );
};
