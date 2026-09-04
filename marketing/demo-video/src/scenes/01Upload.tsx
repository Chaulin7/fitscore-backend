import React from 'react';
import {interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {AppShell} from '../components/AppShell';
import {Caption} from '../components/Caption';
import {fadeUpStyle} from '../utils/animation';
import {SAMPLE_FILE_NAMES, TOTAL_CV_COUNT} from '../data/candidates';

export const DURATION = 180; // 6s @ 30fps

const DRAG_ON = 8;
const DRAG_OFF = 60;

// Chips land in three waves — how a multi-file select actually arrives —
// rather than one per beat like a metronome.
const CHIP_STARTS = [30, 34, 38, 42, 68, 72, 76, 102, 106, 110];
const MORE_START = 120;

const COUNT_START = 30;
const COUNT_END = 130;
const HEADER_START = 36;

export const UploadScene: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const staged = Math.round(
    interpolate(frame, [COUNT_START, COUNT_END], [0, TOTAL_CV_COUNT], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    }),
  );

  const dragActive = frame >= DRAG_ON && frame < DRAG_OFF;

  return (
    <AppShell activeTab="analyzer">
      <div style={{maxWidth: 1400, margin: '0 auto'}}>
        <div className="card">
          <div className="card-head">
            <span className="card-title">Upload CV</span>
          </div>
          <div className="card-body">
            <div className={`dropzone${dragActive ? ' drag' : ''}`}>
              <div className="dz-icon">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
              </div>
              <div className="dz-label">Drop PDF or DOCX here, or click to browse</div>
              <div className="dz-sub">Supports PDF and DOCX &middot; Max 10 MB per file</div>
            </div>

            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                margin: '18px 0 8px',
                ...fadeUpStyle(frame, HEADER_START, fps),
              }}
            >
              <span style={{fontSize: 13, color: '#6b7280'}}>
                {staged} CV{staged === 1 ? '' : 's'} staged
              </span>
              <button className="btn btn-ghost btn-sm" type="button">
                Clear all
              </button>
            </div>

            <div className="file-list">
              {SAMPLE_FILE_NAMES.map((name, i) => (
                <div key={name} className="file-chip" style={fadeUpStyle(frame, CHIP_STARTS[i], fps)}>
                  <span>{name}</span>
                  <button type="button" style={{background: 'none', border: 'none', color: '#93c5fd', fontSize: 15, lineHeight: 1}}>
                    &#x2715;
                  </button>
                </div>
              ))}
              {staged > SAMPLE_FILE_NAMES.length ? (
                <div
                  className="file-chip"
                  style={{
                    ...fadeUpStyle(frame, MORE_START, fps),
                    background: '#f3f4f6',
                    color: '#6b7280',
                    borderColor: '#e5e7eb',
                  }}
                >
                  <span>+{staged - SAMPLE_FILE_NAMES.length} more</span>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
      <Caption
        text="40 CVs. One role. No LLM anywhere in the pipeline."
        durationInFrames={DURATION}
      />
    </AppShell>
  );
};
