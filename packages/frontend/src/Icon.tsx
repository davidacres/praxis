/**
 * Thin-stroke 16x16 icon set in the VS Code (codicon) visual idiom.
 *
 * Every glyph is authored on the same 16x16 grid at the same stroke weight so
 * the window chrome, sidebars, trees and composer read as one system. Icons are
 * inline SVG rather than a font/library so they inherit `currentColor` and stay
 * dependency-free.
 */

export type IconName =
  // window chrome
  | 'sidebar-left'
  | 'sidebar-right'
  | 'panel-bottom'
  | 'arrow-left'
  | 'arrow-right'
  | 'play'
  | 'radio-tower'
  | 'theme'
  | 'window-minimize'
  | 'window-maximize'
  | 'window-restore'
  | 'window-close'
  // controls
  | 'chevron-down'
  | 'chevron-right'
  | 'chevron-up'
  | 'search'
  | 'sliders'
  | 'plus'
  | 'close'
  | 'mic'
  | 'arrow-up'
  | 'check-square'
  | 'shield'
  | 'info'
  | 'dot'
  | 'pencil'
  | 'trash'
  | 'ellipsis'
  | 'refresh'
  | 'split-horizontal'
  | 'terminal'
  // structure
  | 'folder'
  | 'folder-open'
  | 'file'
  | 'markdown'
  | 'gear'
  | 'git-branch'
  // features
  | 'chats'
  | 'home'
  | 'robot'
  | 'lightbulb'
  | 'book'
  | 'zap'
  | 'server'
  | 'plug'
  | 'tools'
  // board / work types
  | 'columns'
  | 'list'
  | 'target'
  | 'rocket'
  | 'milestone'
  | 'bug'
  | 'star'
  | 'graph'
  | 'organization'
  | 'archive'
  | 'external-link'
  | 'copy'
  | 'link'
  | 'paperclip'
  | 'ticket'
  // task designer
  | 'cursor'
  | 'note'
  | 'globe'
  | 'zoom-in'
  | 'zoom-out'
  | 'check'
  | 'sparkles';

const PATHS: Record<IconName, string | string[]> = {
  'sidebar-left': [
    'M2.5 3.25h11a1.25 1.25 0 0 1 1.25 1.25v7a1.25 1.25 0 0 1-1.25 1.25h-11A1.25 1.25 0 0 1 1.25 11.5v-7A1.25 1.25 0 0 1 2.5 3.25z',
    'M5.9 3.25v9.5'
  ],
  'sidebar-right': [
    'M2.5 3.25h11a1.25 1.25 0 0 1 1.25 1.25v7a1.25 1.25 0 0 1-1.25 1.25h-11A1.25 1.25 0 0 1 1.25 11.5v-7A1.25 1.25 0 0 1 2.5 3.25z',
    'M10.1 3.25v9.5'
  ],
  'panel-bottom': [
    'M2.5 3.25h11a1.25 1.25 0 0 1 1.25 1.25v7a1.25 1.25 0 0 1-1.25 1.25h-11A1.25 1.25 0 0 1 1.25 11.5v-7A1.25 1.25 0 0 1 2.5 3.25z',
    'M1.25 10h13.5'
  ],
  'arrow-left': 'M9.6 3.6 5.2 8l4.4 4.4',
  'arrow-right': 'M6.4 3.6 10.8 8l-4.4 4.4',
  play: 'M5.6 3.7 12 8l-6.4 4.3z',
  'radio-tower': [
    'M4.3 4.3a5 5 0 0 0 0 7.4M11.7 4.3a5 5 0 0 1 0 7.4',
    'M6 6.1a2.6 2.6 0 0 0 0 3.8M10 6.1a2.6 2.6 0 0 1 0 3.8'
  ],
  theme: ['M8 1.6a6.4 6.4 0 1 0 0 12.8A6.4 6.4 0 0 0 8 1.6z', 'M8 1.6v12.8M1.6 8h12.8'],
  'window-minimize': 'M3 8h10',
  'window-maximize': 'M3.6 3.6h8.8v8.8H3.6z',
  'window-restore': ['M5.2 5.2V3.4h7.4v7.4h-1.8', 'M3.4 5.2h7.4v7.4H3.4z'],
  'window-close': 'M3.9 3.9 12.1 12.1M12.1 3.9 3.9 12.1',
  'chevron-down': 'M4.2 6.3 8 10.1l3.8-3.8',
  'chevron-right': 'M6.3 4.2 10.1 8l-3.8 3.8',
  'chevron-up': 'M4.2 9.7 8 5.9l3.8 3.8',
  search: ['M7.2 2.6a4.6 4.6 0 1 0 0 9.2 4.6 4.6 0 0 0 0-9.2z', 'M10.6 10.6 14 14'],
  sliders: [
    'M1.6 5.2h1.6M6.4 5.2h8M1.6 10.8h7.2M12 10.8h2.4',
    'M6.4 5.2a1.6 1.6 0 1 1-3.2 0 1.6 1.6 0 0 1 3.2 0zM12 10.8a1.6 1.6 0 1 1-3.2 0 1.6 1.6 0 0 1 3.2 0z'
  ],
  plus: 'M8 3.4v9.2M3.4 8h9.2',
  close: 'M4.2 4.2 11.8 11.8M11.8 4.2 4.2 11.8',
  mic: ['M8 2.2a1.9 1.9 0 0 1 1.9 1.9v3.6a1.9 1.9 0 0 1-3.8 0V4.1A1.9 1.9 0 0 1 8 2.2z', 'M4.4 7.6a3.6 3.6 0 0 0 7.2 0M8 11.2v2.6'],
  'arrow-up': 'M8 12.6V3.6M4.4 7.2 8 3.6l3.6 3.6',
  'check-square': ['M3.4 2.6h9.2a.8.8 0 0 1 .8.8v9.2a.8.8 0 0 1-.8.8H3.4a.8.8 0 0 1-.8-.8V3.4a.8.8 0 0 1 .8-.8z', 'M5.2 8.1 7.2 10l3.6-3.9'],
  shield: 'M8 1.9 13 3.7v4c0 3-2.1 5.3-5 6.4-2.9-1.1-5-3.4-5-6.4v-4z',
  info: ['M8 1.9a6.1 6.1 0 1 0 0 12.2A6.1 6.1 0 0 0 8 1.9z', 'M8 7.2v4M8 4.9v.1'],
  dot: 'M8 5.6a2.4 2.4 0 1 1 0 4.8 2.4 2.4 0 0 1 0-4.8z',
  pencil: ['M11.1 2.6l2.3 2.3', 'M11.6 2.1a1.4 1.4 0 0 1 2 2L5.2 12.5l-3 1 1-3 8.4-8.4z'],
  folder:
    'M1.6 12.4V3.9a1 1 0 0 1 1-1h3.1a1 1 0 0 1 .8.4l.9 1.2a1 1 0 0 0 .8.4h4.2a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H2.6a1 1 0 0 1-1-1z',
  'folder-open': [
    'M1.6 12.4V3.9a1 1 0 0 1 1-1h3.1a1 1 0 0 1 .8.4l.9 1.2a1 1 0 0 0 .8.4h4.2a1 1 0 0 1 1 1v1',
    'M1.6 12.4 3.2 7.9a1 1 0 0 1 .95-.7h9.9a.7.7 0 0 1 .66.95l-1.5 4.05a1 1 0 0 1-.94.6H2.6a1 1 0 0 1-1-1z'
  ],
  file: ['M3.4 1.9h5.3l3.9 3.9v8.3H3.4z', 'M8.7 1.9v3.9h3.9'],
  markdown: ['M1.9 4.1h12.2v7.8H1.9z', 'M4.2 10V6.4l1.8 2 1.8-2V10M10.6 6.4V10M9.2 8.6l1.4 1.4 1.4-1.4'],
  gear: ['M8 5.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8z', 'M8 1.4l.9 1.6 1.8-.3.4 1.8 1.7.7-.7 1.7.7 1.7-1.7.7-.4 1.8-1.8-.3L8 14.6l-.9-1.6-1.8.3-.4-1.8-1.7-.7.7-1.7-.7-1.7 1.7-.7.4-1.8 1.8.3z'],
  'git-branch': ['M4.6 3.1a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM11.4 3.1a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM4.6 10.9a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z', 'M4.6 6.1v4.8M11.4 6.1v1.2a2.4 2.4 0 0 1-2.4 2.4H6.9'],
  chats: ['M1.9 3.4h8.4v5.6H5.1L2.6 11.1V9H1.9z', 'M6.2 5.3h7.9v5.6h-.7v2.1l-2.5-2.1H8.4'],
  home: ['M2.4 7.1 8 2.5l5.6 4.6v5.9a1 1 0 0 1-1 1H3.4a1 1 0 0 1-1-1z', 'M6.4 14v-4.3h3.2V14'],
  robot: ['M4.1 5.4h7.8a1 1 0 0 1 1 1v5.1a1 1 0 0 1-1 1H4.1a1 1 0 0 1-1-1V6.4a1 1 0 0 1 1-1z', 'M8 3v2.4M6.2 8.5v1.2M9.8 8.5v1.2'],
  lightbulb: ['M8 1.9a4.1 4.1 0 0 0-2.4 7.4v1.5h4.8V9.3A4.1 4.1 0 0 0 8 1.9z', 'M6.4 12.4h3.2M6.9 14.1h2.2'],
  book: ['M2.4 2.8h4a1.6 1.6 0 0 1 1.6 1.6v8.8a1.6 1.6 0 0 0-1.6-1.6h-4z', 'M13.6 2.8h-4A1.6 1.6 0 0 0 8 4.4v8.8a1.6 1.6 0 0 1 1.6-1.6h4z'],
  zap: 'M9.2 1.6 3.6 9h3.9l-.7 5.4L12.4 7H8.5z',
  server: ['M2.4 2.6h11.2v3.4H2.4zM2.4 10h11.2v3.4H2.4z', 'M4.6 4.3h.1M4.6 11.7h.1'],
  plug: ['M6 1.9v3.4M10 1.9v3.4', 'M4.2 5.3h7.6v2.4a3.8 3.8 0 0 1-3.8 3.8 3.8 3.8 0 0 1-3.8-3.8z', 'M8 11.5v2.6'],
  tools: ['M9.6 3.4a2.9 2.9 0 0 1 3.9 3.6l-8.4 6.4a1.5 1.5 0 0 1-2-2.2z', 'M2.6 3.1l3.4 3.4'],
  columns: ['M2.1 2.9h3.4v10.2H2.1zM6.3 2.9h3.4v10.2H6.3zM10.5 2.9h3.4v10.2h-3.4z'],
  trash: ['M3.2 4.4h9.6', 'M5.4 4.4V2.9h5.2v1.5', 'M4.4 4.4l.7 8.7h5.8l.7-8.7'],
  ellipsis: ['M3.4 8h.01', 'M8 8h.01', 'M12.6 8h.01'],
  refresh: ['M14 8a6 6 0 1 1-6-6c1.68 0 3.29.67 4.49 1.83L14 5.33', 'M14 2v3.33h-3.33'],
  'split-horizontal': ['M2.1 2.9h11.8v10.2H2.1z', 'M8 2.9v10.2'],
  terminal: ['M3.4 4.6L6.2 8l-2.8 3.4', 'M8.2 11.6h4.4'],
  list: 'M2.4 4.2h11.2M2.4 8h11.2M2.4 11.8h7.6',
  target: ['M8 1.9a6.1 6.1 0 1 0 0 12.2A6.1 6.1 0 0 0 8 1.9z', 'M8 5.1a2.9 2.9 0 1 0 0 5.8 2.9 2.9 0 0 0 0-5.8z'],
  rocket: ['M8 1.6c2.4 1.7 3.6 4.1 3.6 6.6L8 11.4 4.4 8.2c0-2.5 1.2-4.9 3.6-6.6z', 'M4.4 8.2 2.6 10v3.4l2.7-1.6M11.6 8.2 13.4 10v3.4l-2.7-1.6'],
  milestone: ['M8 1.9v12.2', 'M8 3.4h5.2l-1.4 2 1.4 2H8z'],
  bug: ['M5.1 6.4a2.9 2.9 0 0 1 5.8 0v3.2a2.9 2.9 0 0 1-5.8 0z', 'M6.2 4.6a2 2 0 0 1 3.6 0M2.6 7.2h2.5M10.9 7.2h2.5M2.6 11.2h2.5M10.9 11.2h2.5'],
  star: 'M8 1.9 9.9 6l4.2.5-3.1 3 .8 4.2L8 11.7l-3.8 2 .8-4.2-3.1-3L6.1 6z',
  graph: ['M2.4 13.1V2.9', 'M2.4 13.1h11.2', 'M4.9 10.6l2.6-3 2.4 1.9 3.1-4'],
  organization: ['M6.4 1.9h3.2v3.2H6.4zM2.1 10.9h3.2v3.2H2.1zM10.7 10.9h3.2v3.2h-3.2z', 'M8 5.1v3.2M3.7 10.9V8.3h8.6v2.6'],
  archive: ['M1.9 2.9h12.2v2.9H1.9z', 'M3.1 5.8h9.8v7.3H3.1z', 'M6.4 8.6h3.2'],
  'external-link': ['M6.4 3.4h6.2v6.2', 'M12.6 3.4 8 8', 'M10.6 9.6v3H3.4V5.4h3'],
  copy: ['M5.6 5.6h7.4v7.4H5.6z', 'M10.4 5.6V3H3v7.4h2.6'],
  link: ['M6.4 9.6a2.6 2.6 0 0 1 0-3.7l1.9-1.9a2.6 2.6 0 0 1 3.7 3.7l-1 1', 'M9.6 6.4a2.6 2.6 0 0 1 0 3.7l-1.9 1.9a2.6 2.6 0 0 1-3.7-3.7l1-1'],
  paperclip: ['M11.8 7.6 6.9 12.5a2.8 2.8 0 0 1-4-4l5.6-5.6a1.9 1.9 0 0 1 2.7 2.7l-5.6 5.6a1 1 0 0 1-1.4-1.4l4.6-4.6'],
  ticket: ['M1.9 4.6h12.2v2.2a1.2 1.2 0 0 0 0 2.4v2.2H1.9V9.2a1.2 1.2 0 0 0 0-2.4z', 'M8 5.6v1.2M8 9.2v1.2'],
  cursor: 'M4.2 2.4 12 8.4l-4 .6-2.2 3.8z',
  note: ['M2.9 2.4h10.2v8.6l-3.5 3.5H2.9z', 'M13.1 11H9.6v3.5'],
  globe: ['M8 1.9a6.1 6.1 0 1 0 0 12.2A6.1 6.1 0 0 0 8 1.9z', 'M1.9 8h12.2', 'M8 1.9c-3.6 3.9-3.6 8.3 0 12.2 3.6-3.9 3.6-8.3 0-12.2z'],
  'zoom-in': ['M7.2 2.6a4.6 4.6 0 1 0 0 9.2 4.6 4.6 0 0 0 0-9.2z', 'M10.6 10.6 14 14', 'M7.2 5.2v4M5.2 7.2h4'],
  'zoom-out': ['M7.2 2.6a4.6 4.6 0 1 0 0 9.2 4.6 4.6 0 0 0 0-9.2z', 'M10.6 10.6 14 14', 'M5.2 7.2h4'],
  check: 'M3.2 8.4 6.6 11.8 12.8 4.4',
  sparkles: ['M8 2.4l1.4 3.4 3.4 1.4-3.4 1.4L8 12l-1.4-3.4-3.4-1.4 3.4-1.4z', 'M12.4 10.4l.7 1.7 1.7.7-1.7.7-.7 1.7-.7-1.7-1.7-.7 1.7-.7z']
};

/** Glyphs drawn as solid shapes rather than outlines. */
const FILLED: ReadonlySet<IconName> = new Set<IconName>(['play', 'dot']);

export interface IconProps {
  name: IconName;
  /** Rendered box in px; the grid scales uniformly. */
  size?: number;
  className?: string;
  strokeWidth?: number;
}

export function Icon({ name, size = 16, className, strokeWidth = 1.2 }: IconProps) {
  const raw = PATHS[name];
  const paths = Array.isArray(raw) ? raw : [raw];
  const filled = FILLED.has(name);

  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={filled ? undefined : strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths.map((d, index) => (
        <path key={index} d={d} fill={filled ? 'currentColor' : 'none'} />
      ))}
    </svg>
  );
}
