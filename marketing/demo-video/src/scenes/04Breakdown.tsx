import React from 'react';
import {useCurrentFrame, useVideoConfig} from 'remotion';
import {AppShell} from '../components/AppShell';
import {Caption} from '../components/Caption';
import {PushIn} from '../components/PushIn';
import {RingScore} from '../components/RingScore';
import {fadeUpStyle, ghostReveal, highlightSweep} from '../utils/animation';
import {HERO_CANDIDATE} from '../data/candidates';
import {color} from '../theme';

export const DURATION = 480; // 16s @ 30fps — the hero shot.

// The real UI fills all five rings at once (one CSS transition, see
// renderSingleResult in public/app.html), so they land together here too.
// The "each line in sequence" motion belongs to the evidence below them.
const RING_START = 25;
const RING_STAGGER = 4;
const RING_DURATION = 36;

const CHIPS_START = 90;
const CHIP_STAGGER = 10;

// The cadence tightens slightly as the eye moves down — the rhythm of
// reading a list, not a metronome.
const SKILLS_STARTS = [175, 199, 221, 241, 259, 276];
const WHY_STARTS = [310, 334, 356, 376, 394];

type Ring = {
  key: 'overall' | 'keywords' | 'skills' | 'experience' | 'education';
  label: string;
  ringColor: string;
  whyText: string;
};

const RINGS: Ring[] = [
  {key: 'overall', label: 'Overall', ringColor: color.success, whyText: `Overall: ${HERO_CANDIDATE.overall}/100`},
  {key: 'keywords', label: 'Keywords', ringColor: color.keywordBlue, whyText: `Keywords ${HERO_CANDIDATE.scores.keywords} — match between job title, required terms and CV content.`},
  {key: 'skills', label: 'Skills', ringColor: color.skillsPurple, whyText: `Skills ${HERO_CANDIDATE.scores.skills} — technical and soft skills alignment with the role requirements.`},
  {key: 'experience', label: 'Experience', ringColor: color.experienceAmber, whyText: `Experience ${HERO_CANDIDATE.scores.experience} — years of relevant experience and seniority match.`},
  {key: 'education', label: 'Education', ringColor: color.success, whyText: `Education ${HERO_CANDIDATE.scores.education} — academic qualifications and certifications match.`},
];

export const BreakdownScene: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const missingStart = CHIPS_START + HERO_CANDIDATE.found.length * CHIP_STAGGER + 14;

  return (
    <AppShell activeTab="analyzer">
      <PushIn durationInFrames={DURATION} fromScale={1} toScale={1.03}>
        <div style={{maxWidth: 1400, margin: '0 auto'}}>
          <div className="card">
            <div className="card-head">
              <span className="card-title">{HERO_CANDIDATE.name} · Results</span>
            </div>
            <div className="card-body" style={{paddingBottom: 12}}>
              <div className="score-row" style={{marginBottom: 16}}>
                {RINGS.map((r, i) => (
                  <RingScore
                    key={r.key}
                    label={r.label}
                    value={r.key === 'overall' ? HERO_CANDIDATE.overall : HERO_CANDIDATE.scores[r.key]}
                    isOverall={r.key === 'overall'}
                    color={r.ringColor}
                    fillStartFrame={RING_START + i * RING_STAGGER}
                    fillDurationInFrames={RING_DURATION}
                  />
                ))}
              </div>

              <div className="section-sub">Keywords Found</div>
              <div className="chip-list">
                {HERO_CANDIDATE.found.map((k, i) => (
                  <span key={k} className="chip chip-found" style={fadeUpStyle(frame, CHIPS_START + i * CHIP_STAGGER, fps)}>
                    {k}
                  </span>
                ))}
              </div>
              <div className="section-sub">Keywords Missing</div>
              <div className="chip-list" style={{marginBottom: 10}}>
                {HERO_CANDIDATE.missing.map((k) => (
                  <span key={k} className="chip chip-miss" style={fadeUpStyle(frame, missingStart, fps)}>
                    {k}
                  </span>
                ))}
              </div>

              <div className="section-sub" style={{marginTop: 4}}>
                Skills
              </div>
              <table className="data-table" style={{marginBottom: 8}}>
                <thead>
                  <tr>
                    <th>Skill</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {HERO_CANDIDATE.skills.map((s, i) => {
                    const start = SKILLS_STARTS[i];
                    return (
                      <tr key={s.name} style={{...ghostReveal(frame, start, fps), ...highlightSweep(frame, start)}}>
                        <td style={{fontWeight: 600}}>{s.name}</td>
                        <td>
                          <span className={`badge ${s.found ? 'badge-green' : 'badge-red'}`}>
                            {s.found ? '✓ Found' : '✗ Missing'}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              <div className="section-sub">Why this score</div>
              <div className="why-box" style={{marginTop: 0}}>
                {RINGS.map((r, i) => (
                  <div key={r.key} className="why-row" style={highlightSweep(frame, WHY_STARTS[i])}>
                    <strong>{r.whyText}</strong>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </PushIn>
      <Caption text="Every point traced to a line in the CV." durationInFrames={DURATION} />
    </AppShell>
  );
};
