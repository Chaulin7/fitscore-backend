import React from 'react';
import {AbsoluteFill} from 'remotion';
import {Brandmark} from './Brandmark';

// The real app topbar (fitscore-backend/public/app.html, .topbar / .topbar-nav
// / .nav-btn), reproduced with the same markup shape and class names so the
// CSS in styles/cvsprings.css applies unmodified.
export const AppShell: React.FC<{
  activeTab: 'analyzer' | 'audit' | 'history' | 'bias';
  children: React.ReactNode;
}> = ({activeTab, children}) => {
  const navItem = (tab: string, label: string) => (
    <button
      key={tab}
      className={`nav-btn${activeTab === tab ? ' active' : ''}`}
      type="button"
    >
      {label}
    </button>
  );

  return (
    <AbsoluteFill style={{background: '#f0f2f5'}}>
      <div className="topbar">
        <div className="topbar-brand">
          <Brandmark size={50} variant="white" />
          <span className="brand-name">
            CV<em>springs</em>
          </span>
        </div>
        <nav className="topbar-nav">
          {navItem('analyzer', 'Analyzer')}
          {navItem('audit', 'Audit Log')}
          {navItem('history', 'Role History')}
          {navItem('bias', 'Bias monitoring')}
        </nav>
        <span className="nav-status-pill">
          <span className="dot ok" />
          <span>Connected</span>
        </span>
      </div>
      <div className="main" style={{flex: 1, overflow: 'hidden'}}>
        {children}
      </div>
    </AbsoluteFill>
  );
};
