import { useEffect, useRef } from 'react';

/** The reference's horizon and focus grid, drawn behind the real editable field. */
export function AmbientComposerHorizon({ state = 'idle', preview = false }: {
  state?: 'idle' | 'thinking' | 'approval'; preview?: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    const ctx = element?.getContext('2d');
    if (!element || !ctx) return;
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0, time = 0, previous = 0;
    const resize = () => {
      const dpr = devicePixelRatio || 1;
      element.width = element.clientWidth * dpr;
      element.height = element.clientHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    const draw = (now: number) => {
      const focused = !!element.closest('.ambient-composer-canvas')?.matches(':focus-within');
      const width = element.clientWidth, height = element.clientHeight;
      const base = preview ? 46 : Math.min(24, height - 20);
      const amplitude = preview ? 3 : state === 'thinking' ? 16 : state === 'approval' ? 9 : focused ? 6 : 4;
      const speed = state === 'thinking' ? 3.2 : state === 'approval' ? 1.4 : focused ? .8 : .5;
      if (!motion.matches && previous) time += Math.min((now - previous) / 1000, .05) * speed;
      previous = now;
      const color = getComputedStyle(element).color;
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = color;
      if (focused || state !== 'idle') {
        for (let x = 12; x < width; x += 22) for (let y = base + 8; y < height; y += 22) {
          ctx.globalAlpha = .18 * (1 - (y - base) / Math.max(1, height - base));
          ctx.fillRect(x, y, 1.4, 1.4);
        }
      }
      ctx.globalAlpha = 1;
      const glow = ctx.createLinearGradient(0, base - 40, 0, height);
      glow.addColorStop(0, 'transparent'); glow.addColorStop(.25, color); glow.addColorStop(1, 'transparent');
      ctx.globalAlpha = focused ? .12 : .07;
      ctx.fillStyle = glow; ctx.fillRect(0, base - 40, width, height);
      ctx.globalAlpha = 1;
      for (let layer = 0; layer < 3; layer++) {
        ctx.beginPath();
        for (let x = 0; x <= width; x += 4) {
          const y = base + Math.sin(Math.PI * x / width) * (
            Math.sin(x * .012 + time * (1 + layer * .3) + layer) * amplitude
            + Math.sin(x * .031 - time * 1.7 + layer * 2) * amplitude * .35);
          if (x) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        }
        const gradient = ctx.createLinearGradient(0, 0, width, 0);
        gradient.addColorStop(0, 'transparent'); gradient.addColorStop(.5, color); gradient.addColorStop(1, 'transparent');
        ctx.strokeStyle = gradient; ctx.globalAlpha = (.9 - layer * .28) * (focused ? .85 : .55);
        ctx.lineWidth = layer ? 1 : 1.6; ctx.shadowColor = color; ctx.shadowBlur = layer ? 0 : 14;
        ctx.stroke();
      }
      ctx.shadowBlur = 0; ctx.globalAlpha = 1;
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [state, preview]);
  return <div className={`ambient-horizon${preview ? ' is-preview' : ''}`} aria-hidden="true" data-state={state}><canvas ref={canvas} /></div>;
}
