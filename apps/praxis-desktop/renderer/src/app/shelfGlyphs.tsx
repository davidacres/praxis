/**
 * The shelf's two creation glyphs, drawn pixel-for-pixel rather than scaled from
 * the 16-unit icon set: every 1px stroke sits on a half-pixel, so at Compact the
 * edges land on whole device pixels instead of smearing across two. Large gets
 * its own 12px drawing (scaling the 10px one to 11.6px would lose the grid); CSS
 * shows whichever matches `data-display-size`.
 */
const GLYPHS = {
  session: {
    10: ['M.5 .5H8.5V6.5H4.5L2.5 8.5V6.5H.5Z', 'M4.5 2V5M3 3.5H6'],
    12: ['M.5 .5H10.5V8.5H5.5L3.5 10.5V8.5H.5Z', 'M5.5 3V6M4 4.5H7']
  },
  note: {
    10: ['M1.5 .5H6.5L8.5 2.5V9.5H1.5Z', 'M6.5 .5V2.5H8.5M3 5.5H7M3 7.5H6'],
    12: ['M1.5 .5H7.5L10.5 3.5V11.5H1.5Z', 'M7.5 .5V3.5H10.5M3 6.5H9M3 8.5H7']
  }
} as const;

export type ShelfGlyphName = keyof typeof GLYPHS;

export function ShelfGlyph({ name }: { name: ShelfGlyphName }) {
  return <>
    {([10, 12] as const).map(size => <svg key={size} className={`session-shelf__glyph session-shelf__glyph--${size}`}
      width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="none" stroke="currentColor"
      strokeWidth={1} strokeLinecap="butt" strokeLinejoin="miter" aria-hidden="true" focusable="false">
      {GLYPHS[name][size].map(d => <path key={d} d={d} />)}
    </svg>)}
  </>;
}
