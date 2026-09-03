import { useEffect, useRef, useState } from 'react';

/** Timings for the four phases below — all driven from one rAF loop so the trail and the head never drift apart. */
const CRAWL_MS = 6480;
const SETTLE_MS = 340;
const HOLD_MS = 600;
const FADE_MS = 420;
const TOTAL_MS = CRAWL_MS + SETTLE_MS + HOLD_MS + FADE_MS;

/**
 * Real typography for the whole wordmark, one consistent hand-lettered
 * style. This is Dancing Script's own outline for "Praxis" — a genuine
 * connected cursive/calligraphy typeface, so the letters actually flow into
 * each other instead of sitting as separately-spaced glyphs — generated once
 * via opentype.js from the actual font file and pasted in here as static
 * constants (so the app ships with no font-parsing dependency). Traced as a
 * thin outline stroke rather than filled, in local coordinates — WORD_OFFSET
 * below places it in the shared scene.
 *
 * Split into one string per subpath (letter/contour), rather than one joined
 * string, because the reveal below needs to address individual subpaths —
 * see the big comment in the component for why.
 *
 * Set with a dotless ı (U+0131) — the "i" has no baked-in dot, because the
 * app's own vermillion accent dot lands there instead (see SETTLE below).
 */
const WORD_SUBPATHS = [
  'M43.50 43.50Q31 43.50 20 36.50Q9 29.50 9 18.50Q9 13 11.50 5.25Q14-2.50 16-9Q32-58 46-100.50Q60-143 74-183Q88-223 103.75-263Q119.50-303 139-346.50Q120-343 105.25-336.25Q90.50-329.50 81.50-324.25Q72.50-319 69.50-319Q67.50-319 63.75-321.25Q60-323.50 57-326.75Q54-330 54-332.50Q67-338 84.75-344.50Q102.50-351 123-355.50Q143.50-360 164.50-360Q186.50-360 209.25-354Q232-348 251-335.75Q270-323.50 281.50-305.50Q293-287.50 293-263.50Q293-237.50 281.50-218.75Q270-200 251-187.25Q232-174.50 210-166.75Q188-159 166.25-154.75Q144.50-150.50 127.50-149.25Q110.50-148 102.50-148L97.50-148Q82.50-96.50 68.75-46.50Q55 3.50 43.50 43.50',
  'M99.50-156Q127-157.50 155.25-165Q183.50-172.50 207-186.75Q230.50-201 245-222.25Q259.50-243.50 259.50-272Q259.50-299 246.75-316Q234-333 213.25-341.25Q192.50-349.50 169-349.50Q150.50-313 133-262Q115.50-211 99.50-156',
  'M340 13Q323 13 313.25 4Q303.50-5 303.50-19.50Q303.50-34.50 310.50-51Q317.50-67.50 324.25-83.75Q331-100 331-113Q331-129 321.75-136.75Q312.50-144.50 303-151Q291.50-121.50 279-95Q266.50-68.50 258.50-55L254-63.50Q261-76.50 272.25-101.50Q283.50-126.50 294.50-158.50Q289.50-163.50 289.50-170.50Q289.50-185.50 298-195Q306.50-204.50 310.50-204.50Q316-204.50 316.75-199.75Q317.50-195 317.50-192.50Q317.50-190 314.75-182.75Q312-175.50 312-174Q312-167 319.75-161.25Q327.50-155.50 337.50-148.25Q347.50-141 355.25-130.75Q363-120.50 363-104.50Q363-89.50 356.75-74Q350.50-58.50 344.25-44.50Q338-30.50 338-20Q338-11 342.50-8Q347-5 353-5Q365-5 377.75-12.50Q390.50-20 402.50-31.50Q414.50-43 424-55.75Q433.50-68.50 438-79.50L444.50-74.50Q435-53.50 418.50-33.25Q402-13 381.75 0Q361.50 13 340 13',
  'M451.50 23.50Q436 23.50 425.25 13.25Q414.50 3 414.50-18Q414.50-36 422.50-56.75Q430.50-77.50 444.50-97.75Q458.50-118 476.25-134.75Q494-151.50 513.75-161.50Q533.50-171.50 553-171.50Q572.50-171.50 585.50-161.25Q598.50-151 598.50-134Q598.50-121.50 591.75-117Q585-112.50 574-112.50Q575-116.50 575.75-121.25Q576.50-126 576.50-130Q576.50-141.50 571-149.75Q565.50-158 552-158Q538-158 523.50-148.25Q509-138.50 495.50-122.25Q482-106 471.50-87Q461-68 455-49.50Q449-31 449-16.50Q449 3 462.50 3Q474 3 487.50-7.75Q501-18.50 515.25-35.25Q529.50-52 542.50-70Q555.50-88 565.50-103Q567.50-106 568-106Q571-105.50 575.75-104Q580.50-102.50 584-100Q587.50-97.50 587.50-93.50Q587.50-89 583-81.25Q578.50-73.50 573-63.50Q567.50-53.50 563-43.25Q558.50-33 558.50-24Q558.50-16.50 562.50-9.25Q566.50-2 575.50-2Q589-2 611-21.75Q633-41.50 655.50-81L660.50-76Q650-49 633.50-28.50Q617-8 598.25 3.50Q579.50 15 561.50 15Q543 15 534.25 4Q525.50-7 525.50-20Q525.50-23 526-26.75Q526.50-30.50 527-34.50Q505.50-5.50 487.75 9Q470 23.50 451.50 23.50',
  'M667.50 29.50Q665.50 29.50 664 27.50Q662.50 25.50 662.50 22Q662.50 16 673 0.75Q683.50-14.50 700.25-35.50Q717-56.50 736.50-78Q734-101.50 730-118.75Q726-136 714.50-136Q702.50-136 693-125.75Q683.50-115.50 674.50-99.25Q665.50-83 655-64.50L650.50-72.50Q657.50-86 663.75-100.50Q670-115 677.50-127.50Q685-140 695.75-147.75Q706.50-155.50 722.50-155.50Q742-155.50 751.25-141.75Q760.50-128 764-108Q787.50-132.50 806.50-149.25Q825.50-166 832-166Q834.50-166 839.50-164.50Q844.50-163 844.50-160.50Q839-160.50 827-150.75Q815-141 799.50-124.50Q784-108 767-88.50Q768.50-73.50 769.50-58.50Q770.50-43.50 772.75-31.50Q775-19.50 780-12.25Q785-5 794-5Q803-5 813.25-12.50Q823.50-20 833.25-31.75Q843-43.50 851.25-56.50Q859.50-69.50 864.50-80.50L869.50-75.50Q862.50-54 848.25-33.75Q834-13.50 816.50-0.25Q799 13 781.50 13Q767 13 758.50 3.25Q750-6.50 745.75-22.25Q741.50-38 739-55.50Q718-30.50 700.25-8Q682.50 14.50 673.50 26Q670.50 29.50 667.50 29.50',
  'M890.50 13Q871 13 861.50 0.75Q852-11.50 852-29Q852-40.50 856.25-58Q860.50-75.50 867.50-94.75Q874.50-114 883.75-131Q893-148 903.50-158.75Q914-169.50 924-169.50Q928.50-169.50 931.75-166.75Q935-164 935-158.50Q935-152.50 927.25-139Q919.50-125.50 909-108Q898.50-90.50 890.75-71.25Q883-52 883-34.50Q883-16.50 889-10.50Q895-4.50 907.50-4.50Q924.50-4.50 943.75-21.50Q963-38.50 984.50-81L989-76Q974.50-33 947.25-10Q920 13 890.50 13',
  'M1027.50 25.50Q1004 25.50 990.25 15.25Q976.50 5 970.75-10Q965-25 965-40Q965-55 969-63Q973-71 978.75-75Q984.50-79 989.75-81Q995-83 997-85Q1012-101.50 1024.50-119.50Q1037-137.50 1046.50-157.50L1046.50-163.50Q1046.50-182 1052.75-189.75Q1059-197.50 1066-197.50Q1070-197.50 1072-195.50Q1074-193.50 1074-191Q1074-188.50 1072.50-183Q1071-177.50 1071-169Q1071-152.50 1077.50-133.25Q1084-114 1090.50-92.75Q1097-71.50 1097-48.50Q1097-42 1096.25-35.75Q1095.50-29.50 1094-24Q1111.50-27 1127-39.75Q1142.50-52.50 1157-80.50L1161.50-75.50Q1152-48 1133-33.75Q1114-19.50 1091.50-16Q1083.50 5.50 1066.25 15.50Q1049 25.50 1027.50 25.50',
  'M1028.50 8Q1034.50 8 1044.50 4Q1054.50 0 1060-16.50Q1039-20.50 1022.75-33Q1006.50-45.50 998.50-58Q987.50-57.50 987.50-40.50Q987.50-22.50 998.25-7.25Q1009 8 1028.50 8',
  'M1062.50-24.50Q1063.50-29.50 1064-35Q1064.50-40.50 1064.50-48Q1064.50-71.50 1058.75-94.75Q1053-118 1049-138.50Q1037.50-119.50 1024.75-102.25Q1012-85 1000.50-73.50Q1008-57.50 1023.75-43.50Q1039.50-29.50 1062.50-24.50'
];
const WORD_PATH_LOCAL = WORD_SUBPATHS.join('');

/** Places the local word-path coordinates (font baseline at y=0) into the shared scene (baseline at y=792). */
const WORD_OFFSET = { x: 460, y: 792 };
/** Where the traced path ends, in local coordinates (tail of the "s"). */
const PATH_END_LOCAL = { x: 1063, y: -24.5 };
/** The dotted-i's dot centre from Dancing Script, in local coordinates — the "i" dot's resting spot, reached by a short hop after the main path finishes, same trick as the standalone icon's rivet. */
const RIVET_LOCAL = { x: 956.5, y: -237.25 };
const PATH_END = { x: PATH_END_LOCAL.x + WORD_OFFSET.x, y: PATH_END_LOCAL.y + WORD_OFFSET.y };
const RIVET = { x: RIVET_LOCAL.x + WORD_OFFSET.x, y: RIVET_LOCAL.y + WORD_OFFSET.y };
/** Where the very first subpath begins, in local coordinates — the head's starting position before it starts moving. */
const PATH_START_LOCAL = { x: 43.5, y: 43.5 };
const PATH_START = { x: PATH_START_LOCAL.x + WORD_OFFSET.x, y: PATH_START_LOCAL.y + WORD_OFFSET.y };

/** How many straight-line samples approximate the currently-drawing letter's remaining curve. Only the one active subpath is ever sampled this way — finished letters keep their real, smooth Q-curve data. */
const SAMPLES_PER_ACTIVE_SUBPATH = 60;

/** Static, compact version of the splash wordmark for the application chrome. */
export function PraxisWordmark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="430 400 1250 470"
      className={className}
      aria-label="Praxis"
      role="img"
    >
      <path
        d={WORD_PATH_LOCAL}
        transform={`translate(${WORD_OFFSET.x} ${WORD_OFFSET.y})`}
        className="praxis-wordmark-trail"
      />
      <circle
        r="20"
        cx={RIVET.x}
        cy={RIVET.y}
        className="praxis-wordmark-dot"
      />
    </svg>
  );
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}
function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

export function StartupSplash({ onDone, version, brief = false }: { onDone: () => void; version?: string; brief?: boolean }) {
  const [phase, setPhase] = useState<'crawl' | 'hold' | 'fade'>(brief ? 'hold' : 'crawl');
  const wordRef = useRef<SVGPathElement>(null);
  const helperRef = useRef<SVGPathElement>(null);
  const headCircleRef = useRef<SVGCircleElement>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const raf = useRef<number>(0);
  const done = useRef(false);

  const finish = () => {
    if (done.current) return;
    done.current = true;
    onDone();
  };

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      timers.current.push(setTimeout(finish, 200));
      return () => timers.current.forEach(clearTimeout);
    }

    // A user who has been through onboarding once gets the brand mark, not the
    // 6.5s crawl: the finished wordmark, a short hold, and a fade.
    if (brief) {
      if (wordRef.current) wordRef.current.setAttribute('d', WORD_PATH_LOCAL);
      if (headCircleRef.current) {
        headCircleRef.current.setAttribute('cx', String(RIVET.x));
        headCircleRef.current.setAttribute('cy', String(RIVET.y));
      }
      timers.current.push(
        setTimeout(() => setPhase('fade'), HOLD_MS),
        setTimeout(finish, HOLD_MS + FADE_MS)
      );
      return () => timers.current.forEach(clearTimeout);
    }

    const wordPath = wordRef.current!;
    const helper = helperRef.current!;
    const headCircle = headCircleRef.current!;

    // Why this exists: stroke-dasharray/dashoffset restarts its pattern at
    // the start of every subpath, so it can't do a simple "reveal up to
    // distance X" across a multi-letter path (confirmed empirically — an
    // earlier attempt at drawing the head that way produced one dot per
    // letter instead of one). And a plain `getPointAtLength` head next to a
    // dasharray-revealed trail can drift visibly out of sync on a path this
    // curve-heavy, especially once slowed down. So instead: precompute each
    // letter's own length once, and each frame, rebuild the trail's `d`
    // attribute directly — full smooth Q-curve data for every finished
    // letter, plus a short sampled polyline for the one letter currently
    // being drawn, built from the exact same `getPointAtLength` calls used
    // for the head. Trail and head are then reading the same numbers by
    // construction, not two systems that merely ought to agree.
    const subLengths: number[] = [];
    for (const sp of WORD_SUBPATHS) {
      helper.setAttribute('d', sp);
      subLengths.push(helper.getTotalLength());
    }
    const cumulative: number[] = [];
    let acc = 0;
    for (const len of subLengths) {
      cumulative.push(acc);
      acc += len;
    }
    const totalLength = acc;

    function renderUpTo(distance: number) {
      const clamped = Math.max(0, Math.min(distance, totalLength));
      let activeIndex = WORD_SUBPATHS.length - 1;
      for (let i = 0; i < WORD_SUBPATHS.length; i++) {
        if (clamped < cumulative[i] + subLengths[i]) {
          activeIndex = i;
          break;
        }
      }

      const parts: string[] = [];
      for (let i = 0; i < activeIndex; i++) parts.push(WORD_SUBPATHS[i]);

      const localDistance = Math.max(0, Math.min(clamped - cumulative[activeIndex], subLengths[activeIndex]));
      helper.setAttribute('d', WORD_SUBPATHS[activeIndex]);
      let headX = 0;
      let headY = 0;
      let polyline = '';
      for (let s = 0; s <= SAMPLES_PER_ACTIVE_SUBPATH; s++) {
        const len = (localDistance * s) / SAMPLES_PER_ACTIVE_SUBPATH;
        const pt = helper.getPointAtLength(len);
        polyline += (s === 0 ? 'M' : 'L') + pt.x + ' ' + pt.y + ' ';
        headX = pt.x;
        headY = pt.y;
      }
      parts.push(polyline);

      wordPath.setAttribute('d', parts.join(''));
      headCircle.setAttribute('cx', String(headX + WORD_OFFSET.x));
      headCircle.setAttribute('cy', String(headY + WORD_OFFSET.y));
    }

    renderUpTo(0);
    const start = performance.now();

    function tick(now: number) {
      const elapsed = now - start;
      if (elapsed < CRAWL_MS) {
        const t = easeInOutQuad(elapsed / CRAWL_MS);
        renderUpTo(t * totalLength);
        raf.current = requestAnimationFrame(tick);
      } else if (elapsed < CRAWL_MS + SETTLE_MS) {
        wordPath.setAttribute('d', WORD_PATH_LOCAL);
        const t = easeOutCubic((elapsed - CRAWL_MS) / SETTLE_MS);
        headCircle.setAttribute('cx', String(PATH_END.x + (RIVET.x - PATH_END.x) * t));
        headCircle.setAttribute('cy', String(PATH_END.y + (RIVET.y - PATH_END.y) * t));
        raf.current = requestAnimationFrame(tick);
      } else {
        wordPath.setAttribute('d', WORD_PATH_LOCAL);
        headCircle.setAttribute('cx', String(RIVET.x));
        headCircle.setAttribute('cy', String(RIVET.y));
      }
    }
    raf.current = requestAnimationFrame(tick);

    timers.current.push(
      setTimeout(() => setPhase('hold'), CRAWL_MS + SETTLE_MS),
      setTimeout(() => setPhase('fade'), CRAWL_MS + SETTLE_MS + HOLD_MS),
      setTimeout(finish, TOTAL_MS)
    );
    return () => {
      cancelAnimationFrame(raf.current);
      timers.current.forEach(clearTimeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const skip = () => {
    cancelAnimationFrame(raf.current);
    timers.current.forEach(clearTimeout);
    if (wordRef.current) wordRef.current.setAttribute('d', WORD_PATH_LOCAL);
    if (headCircleRef.current) {
      headCircleRef.current.setAttribute('cx', String(RIVET.x));
      headCircleRef.current.setAttribute('cy', String(RIVET.y));
    }
    setPhase('fade');
    timers.current = [setTimeout(finish, FADE_MS)];
  };

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return null;
  }

  return (
    <div
      className={`startup-splash${phase === 'fade' ? ' startup-splash-fade' : ''}`}
      onClick={skip}
      role="presentation"
      data-testid="startup-splash"
    >
      <div className="startup-splash-content">
        <svg viewBox="430 400 1250 470" className="startup-splash-svg">
          <defs>
            <radialGradient id="startup-splash-dot" cx="0.35" cy="0.3" r="0.8">
              <stop offset="0%" className="startup-splash-dot-highlight" />
              <stop offset="55%" className="startup-splash-dot-core" />
              <stop offset="100%" className="startup-splash-dot-shadow" />
            </radialGradient>
          </defs>
          {/* Off-canvas — used only for getTotalLength/getPointAtLength queries, never rendered. */}
          <path ref={helperRef} d="" style={{ display: 'none' }} />
          <path
            ref={wordRef}
            d=""
            transform={`translate(${WORD_OFFSET.x} ${WORD_OFFSET.y})`}
            className="startup-splash-trail startup-splash-trail-thin"
          />
          <circle ref={headCircleRef} r={20} cx={PATH_START.x} cy={PATH_START.y} fill="url(#startup-splash-dot)" className="startup-splash-head" />
        </svg>
        <div className="startup-splash-loader" role="status" aria-label="Loading Praxis">
          <span className="startup-splash-loader-ring startup-splash-loader-ring-outer" />
          <span className="startup-splash-loader-ring startup-splash-loader-ring-inner" />
        </div>
      </div>
      {version && <span className="startup-splash-version">v{version}</span>}
    </div>
  );
}
