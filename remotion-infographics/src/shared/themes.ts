/**
 * Color palettes for documentary infographic styles.
 * Extracted from remotion-agent.md per-type palettes.
 */

export interface InfographicPalette {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  text: string;
  muted: string;
  glow: string;
}

export const PALETTES: Record<string, InfographicPalette> = {
  statistic: {
    primary: '#6b21a8',
    secondary: '#c084fc',
    accent: '#f59e0b',
    background: 'rgba(15, 23, 42, 0.85)',
    text: '#f1f5f9',
    muted: '#94a3b8',
    glow: 'rgba(139, 92, 246, 0.3)',
  },
  bar_chart: {
    primary: '#0ea5e9',
    secondary: '#38bdf8',
    accent: '#f472b6',
    background: 'rgba(15, 23, 42, 0.85)',
    text: '#f1f5f9',
    muted: '#94a3b8',
    glow: 'rgba(14, 165, 233, 0.3)',
  },
  line_chart: {
    primary: '#10b981',
    secondary: '#34d399',
    accent: '#f59e0b',
    background: 'rgba(15, 23, 42, 0.85)',
    text: '#f1f5f9',
    muted: '#94a3b8',
    glow: 'rgba(16, 185, 129, 0.3)',
  },
  diagram: {
    primary: '#8b5cf6',
    secondary: '#a78bfa',
    accent: '#22d3ee',
    background: 'rgba(15, 23, 42, 0.85)',
    text: '#f1f5f9',
    muted: '#94a3b8',
    glow: 'rgba(139, 92, 246, 0.3)',
  },
  list: {
    primary: '#f59e0b',
    secondary: '#fbbf24',
    accent: '#6366f1',
    background: 'rgba(15, 23, 42, 0.85)',
    text: '#f1f5f9',
    muted: '#94a3b8',
    glow: 'rgba(245, 158, 11, 0.3)',
  },
};

export function getPalette(infographicType: string): InfographicPalette {
  return PALETTES[infographicType] ?? PALETTES['statistic'];
}
