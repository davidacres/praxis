/**
 * Browser-safe mirror of the desktop session palette.
 *
 * Mobile must not import runtime values from the desktop renderer, but these
 * names deliberately follow its surface/text ramp so the conversation and
 * composer read as the same product on either screen.
 */
export const theme = {
  bg: '#0d1722',
  bgSunken: '#091018',
  surface: '#151c24',
  surfaceRaised: '#1b2632',
  input: '#0c131b',
  userMessage: '#172b40',
  assistantMessage: '#171d24',
  border: '#293847',
  borderStrong: '#355472',
  text: '#e4e9ef',
  textSecondary: '#b4bec9',
  textDim: '#7f8b98',
  accent: '#2e8de6',
  accentSoft: '#142b41',
  accentMuted: '#245d8f',
  ok: '#4ec98a',
  warn: '#f0b429',
  danger: '#f0736a',
  /** Translucent chrome over the hex backdrop, and the modal scrim. */
  chrome: 'rgba(9, 16, 24, 0.95)',
  hexShade: 'rgba(7, 15, 24, 0.18)',
  scrim: 'rgba(0, 0, 0, 0.62)',
  warnSoft: '#3a2f12',
  dangerSoft: '#3a1a18',
  camera: '#000000',
  onAccent: '#0b1220',
  radius: 10,
  space: 16,
} as const;
