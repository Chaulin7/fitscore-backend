// Every value here is copied from the real product CSS (fitscore-backend/public/app.html
// and public/bias-report.html), not approximated, so the video matches the shipping UI.
export const color = {
  navyDeep: '#0a1f3d',
  navyMid: '#0f2847',
  navyLight: '#153360',
  navyGradient: 'linear-gradient(135deg, #0a1f3d 0%, #0f2847 60%, #153360 100%)',
  accentSky: '#7dd3fc',
  bg: '#f0f2f5',
  cardBg: '#ffffff',
  border: '#e5e7eb',
  textPrimary: '#111827',
  textSecondary: '#374151',
  textMuted: '#6b7280',
  textFaint: '#9ca3af',
  success: '#059669',
  successStrong: '#15803d',
  successBg: '#dcfce7',
  warning: '#a16207',
  warningBg: '#fef9c3',
  danger: '#dc2626',
  dangerStrong: '#b91c1c',
  dangerBg: '#fee2e2',
  keywordBlue: '#2563eb',
  skillsPurple: '#7c3aed',
  experienceAmber: '#d97706',
  gold: 'linear-gradient(135deg, #f59e0b, #d97706)',
  silver: 'linear-gradient(135deg, #9ca3af, #6b7280)',
  bronze: 'linear-gradient(135deg, #d97706, #92400e)',
  chipFoundBg: '#dcfce7',
  chipFoundText: '#166534',
  chipFoundBorder: '#bbf7d0',
  chipMissBg: '#fee2e2',
  chipMissText: '#991b1b',
  chipMissBorder: '#fecaca',
} as const;

export const font = {
  family: 'Inter, sans-serif',
} as const;

export const VIDEO_WIDTH = 1920;
export const VIDEO_HEIGHT = 1080;
export const FPS = 30;
