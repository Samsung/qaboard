// Design tokens for QA-Board sidebar refresh
// Samsung-inspired color palette and design system

export const colors = {
  // Samsung Brand Colors
  primary: '#1f7ce8',
  primaryDark: '#0d47a1', 
  accent: '#00d4ff',
  
  // Background & Surfaces
  background: '#1a1d23',
  surface: '#252a31',
  surfaceHover: '#2d323a',
  
  // Text
  textPrimary: '#ffffff',
  textSecondary: '#a0a6b0',
  textMuted: '#6c7380',
  
  // Borders & Dividers
  border: '#3a3f47',
  borderLight: '#4a505a',
  
  // Interactive States
  hover: 'rgba(31, 124, 232, 0.1)',
  active: 'rgba(31, 124, 232, 0.2)',
  focus: 'rgba(31, 124, 232, 0.3)',
  
  // Status Colors
  success: '#00c851',
  warning: '#ffbb33',
  danger: '#ff4444',
  info: '#33b5e5',
};

export const spacing = {
  xs: '4px',
  sm: '8px',
  md: '12px',
  lg: '16px',
  xl: '20px',
  xxl: '24px',
  xxxl: '32px',
  
  // Semantic spacing - reduced padding
  sectionGap: '24px',
  itemGap: '6px',
  groupGap: '12px',
  contentPadding: '12px',
};

export const typography = {
  // Font sizes
  xs: '11px',
  sm: '12px',
  base: '14px',
  lg: '16px',
  xl: '18px',
  xxl: '20px',
  
  // Font weights
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
  
  // Line heights
  tight: 1.25,
  normal: 1.5,
  relaxed: 1.75,
};

export const borders = {
  radius: {
    sm: '4px',
    md: '6px',
    lg: '8px',
    xl: '12px',
  },
  width: {
    thin: '1px',
    thick: '2px',
  }
};

export const shadows = {
  sm: '0 1px 3px rgba(0, 0, 0, 0.12), 0 1px 2px rgba(0, 0, 0, 0.24)',
  md: '0 3px 6px rgba(0, 0, 0, 0.16), 0 3px 6px rgba(0, 0, 0, 0.23)',
  lg: '0 10px 20px rgba(0, 0, 0, 0.19), 0 6px 6px rgba(0, 0, 0, 0.23)',
  xl: '0 14px 28px rgba(0, 0, 0, 0.25), 0 10px 10px rgba(0, 0, 0, 0.22)',
  
  // Special shadows
  sidebar: '2px 0 8px rgba(0, 0, 0, 0.1)',
  elevated: '0 4px 12px rgba(0, 0, 0, 0.15)',
};

export const transitions = {
  // Duration
  fast: '150ms',
  normal: '200ms',
  slow: '300ms',
  
  // Easing functions
  easeOut: 'cubic-bezier(0.0, 0.0, 0.2, 1)',
  easeIn: 'cubic-bezier(0.4, 0.0, 1, 1)',
  easeInOut: 'cubic-bezier(0.4, 0.0, 0.2, 1)',
  
  // Common transitions
  default: '200ms cubic-bezier(0.4, 0.0, 0.2, 1)',
  hover: '150ms cubic-bezier(0.0, 0.0, 0.2, 1)',
};

export const breakpoints = {
  // Desktop-focused breakpoints (no mobile)
  laptop: '1024px',
  desktop: '1280px',
  wide: '1440px',
  ultrawide: '1920px',
  
  // Media query helpers
  up: (size) => `@media (min-width: ${breakpoints[size]})`,
  down: (size) => `@media (max-width: ${breakpoints[size]})`,
  between: (min, max) => `@media (min-width: ${breakpoints[min]}) and (max-width: ${breakpoints[max]})`,
};

export const sidebar = {
  // Responsive widths - made more compact
  width: {
    compact: '180px',
    default: '200px', 
    wide: '220px',
  },
  
  // Z-index
  zIndex: 15,
  
  // Animation timing
  collapseTransition: '300ms cubic-bezier(0.4, 0.0, 0.2, 1)',
};