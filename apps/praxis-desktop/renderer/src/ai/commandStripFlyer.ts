/** Concept 1's send flourish: the draft lifts out of the strip and lands in the
 *  thread as a pill. Purely visual — the real turn renders through the normal
 *  optimistic path, so a missing target or reduced motion simply skips it. */
export function launchStripFlyer(text: string, source: HTMLElement | null, thread: HTMLElement | null): void {
  if (!text.trim() || !source || !thread) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (typeof source.animate !== 'function') return;
  const from = source.getBoundingClientRect();
  const bounds = thread.getBoundingClientRect();
  if (from.width < 2 || bounds.height < 2) return;
  const flyer = document.createElement('div');
  flyer.className = 'strip-flyer';
  flyer.textContent = text.trim();
  flyer.style.left = `${from.left}px`;
  flyer.style.top = `${from.top}px`;
  document.body.appendChild(flyer);
  const last = thread.lastElementChild;
  const targetY = Math.min(last ? last.getBoundingClientRect().bottom + 12 : bounds.top + 24, bounds.bottom - 50);
  const dx = bounds.right - 24 - flyer.offsetWidth - from.left;
  const dy = targetY - from.top;
  const animation = flyer.animate([
    { transform: 'translate(0,0) scale(.96)', borderRadius: '999px', opacity: 1 },
    { transform: `translate(${dx * .55}px,${dy * .7 - 30}px) scale(1.05)`, opacity: 1, offset: .6 },
    { transform: `translate(${dx}px,${dy}px) scale(1)`, borderRadius: '12px', opacity: .9 }
  ], { duration: 540, easing: 'cubic-bezier(.2,.8,.2,1)' });
  const done = () => flyer.remove();
  animation.onfinish = done;
  animation.oncancel = done;
}
