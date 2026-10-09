import { useLayoutEffect, useRef } from 'react';

/** Moving accent capsule around the border of a compact running composer. */
export function SessionComposerActivityOrbit({ testId }: { testId: string }) {
  const pathRef = useRef<SVGPathElement>(null);
  const capsuleRef = useRef<SVGGElement>(null);

  useLayoutEffect(() => {
    const path = pathRef.current;
    const svg = path?.ownerSVGElement;
    const capsule = capsuleRef.current;
    if (!path || !svg || !capsule) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let frame = 0;
    let startedAt: number | undefined;
    let cachedLength = 0;
    let lastRendered = 0;
    const frameInterval = 25; // ~40 FPS max to avoid 120Hz display CPU spikes

    const updateGeometry = () => {
      const width = svg.clientWidth;
      const height = svg.clientHeight;
      if (width < 2 || height < 2) return;
      const composer = svg.closest('.session-follow-up-composer');
      const radius = Math.min(Number.parseFloat(getComputedStyle(composer ?? svg).borderTopLeftRadius) || 10, (width - 1) / 2, (height - 1) / 2);
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      path.setAttribute('d', [
        `M ${radius} 0.5 H ${width - radius}`,
        `A ${radius} ${radius} 0 0 1 ${width - 0.5} ${radius}`,
        `V ${height - radius}`,
        `A ${radius} ${radius} 0 0 1 ${width - radius} ${height - 0.5}`,
        `H ${radius}`,
        `A ${radius} ${radius} 0 0 1 0.5 ${height - radius}`,
        `V ${radius}`,
        `A ${radius} ${radius} 0 0 1 ${radius} 0.5 Z`
      ].join(' '));
      cachedLength = path.getTotalLength();
      startedAt = undefined;
    };
    const animate = (now: number) => {
      if (document.hidden) {
        frame = requestAnimationFrame(animate);
        return;
      }
      if (now - lastRendered < frameInterval) {
        frame = requestAnimationFrame(animate);
        return;
      }
      lastRendered = now;

      const length = cachedLength || path.getTotalLength();
      if (length) {
        if (startedAt === undefined) startedAt = now;
        const distance = ((now - startedAt) % 3500) / 3500 * length;
        const point = path.getPointAtLength(distance);
        const next = path.getPointAtLength((distance + Math.min(2, length / 4)) % length);
        const angle = Math.atan2(next.y - point.y, next.x - point.x) * 180 / Math.PI;
        capsule.setAttribute('transform', `translate(${point.x} ${point.y}) rotate(${angle})`);
      }
      frame = requestAnimationFrame(animate);
    };
    updateGeometry();
    frame = requestAnimationFrame(animate);
    const observer = new ResizeObserver(updateGeometry);
    observer.observe(svg);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, []);

  return <svg className="session-composer-activity-orbit" data-testid={testId} aria-hidden="true" viewBox="0 0 100 20" preserveAspectRatio="none">
    <defs>
      <linearGradient id={`${testId}-gradient`} x1="0%" y1="0%" x2="100%" y2="0%">
        <stop className="session-composer-activity-gradient-leading" offset="0%" />
        <stop className="session-composer-activity-gradient-core" offset="55%" />
        <stop className="session-composer-activity-gradient-trailing" offset="100%" />
      </linearGradient>
    </defs>
    <path ref={pathRef} data-activity-guide="true" />
    <g ref={capsuleRef} data-activity-capsule="true">
      <rect x="-16" y="-2" width="32" height="4" rx="2" fill={`url(#${testId}-gradient)`} />
    </g>
  </svg>;
}
