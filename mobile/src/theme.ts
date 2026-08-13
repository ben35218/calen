// Shared design tokens — dark theme. Every screen reads these, so flipping the
// values here flips the whole app.
export const colors = {
  primary: '#4F9DF5',
  primaryDark: '#3B82D6',
  background: '#121212',
  surface: '#1E1E1E',
  // Floating chrome over near-black canvases (the calendar FABs/pills): a black
  // drop shadow is invisible on a black screen, so elevation there is carried
  // by a lighter fill + a faint light rim instead (the Material dark-elevation
  // approach), never by shadow alone.
  surfaceElevated: '#2A2A2C',
  outline: 'rgba(255,255,255,0.12)',
  text: '#ECEDEE',
  textMuted: '#9BA1A6',
  border: '#2C2C2E',
  error: '#EF5350',
  success: '#4CAF50',
  warning: '#FFA726',
};

export const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 };
export const radius = { sm: 8, md: 12, lg: 16 };
