/** Large usage totals, with the unit included. Smaller counts keep their existing display. */
const largeCountFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const units = [
  { value: 1_000_000, suffix: 'Mtok' },
  { value: 1_000_000_000, suffix: 'Btok' },
  { value: 1_000_000_000_000, suffix: 'Ttok' }
];

export function formatLargeTokenCount(total: number): string | undefined {
  if (!Number.isFinite(total) || total < units[0].value) return undefined;
  let index = 0;
  while (index < units.length - 1 && total >= units[index + 1].value) index++;
  // Carry rounding across a unit boundary rather than displaying "1,000 Mtok".
  if (index < units.length - 1 && Math.round(total / units[index].value * 10) / 10 >= 1000) index++;
  return `${largeCountFormatter.format(total / units[index].value)} ${units[index].suffix}`;
}
