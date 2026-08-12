"use client";

/**
 * Procedural fractal tree that draws itself once on mount, then settles
 * into a slow sway. Replaces two earlier animations on the auth screens:
 *
 *  - ui/background-paths.tsx (the diagonal ribbons), which called
 *    Math.random() *inside render* -- so every re-render produced different
 *    transition durations and the server/client HTML never matched. That is
 *    the "glitching / not staying constant" the animation was reported for.
 *  - auth/seed-to-tree-animation.tsx, whose keyframes used camelCased
 *    `clipPath`/`r` inside a CSS string (not valid CSS property names), so
 *    the stem never actually grew and the whole 6s loop restarted forever.
 *
 * Both failure modes are structural here: the geometry is generated once at
 * module scope from a seeded PRNG (identical on server and client, and
 * never regenerated on re-render), and the growth animation runs a single
 * time with `forwards` rather than looping.
 *
 * Technique is the standard recursive fractal tree (trunk -> two children at
 * +/- a spread angle, each a fixed ratio of its parent's length) drawn with
 * the pathLength=1 + stroke-dashoffset "self-drawing line" trick, so each
 * branch's draw can be delayed by its depth and the growth reads as one
 * continuous wave from root to tips.
 */

const VIEW_W = 360;
const VIEW_H = 460;
const ROOT_X = 180;
/** Leaves room below the trunk for the ground shadow to sit *inside* the
 * viewBox -- at the very bottom edge it gets half-clipped. */
const ROOT_Y = 438;

/** Depth 7 is where the twigs get fine enough to read as a tree rather than
 * a diagram; the pruning in grow() keeps the element count off 2^7. */
const MAX_DEPTH = 7;
/** Leaves hang off tips at these depths, which is what fills the crown. */
const LEAF_MIN_DEPTH = 6;

/** Seconds each successive depth waits before it starts drawing. Shorter
 * than BRANCH_DURATION on purpose so the ring of growth overlaps instead of
 * stepping. */
const DEPTH_STEP = 0.16;
const BRANCH_DURATION = 0.62;
/** When the last branch has finished, so the sway can start after it. */
const GROWTH_END = MAX_DEPTH * DEPTH_STEP + BRANCH_DURATION;

/** mulberry32 -- small, fast, and fully deterministic from its seed, which
 * is what keeps SSR and hydration in agreement. */
function makeRng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Branch = {
  id: number;
  d: string;
  width: number;
  opacity: number;
  delay: number;
};

type Leaf = {
  id: number;
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  rotate: number;
  fill: string;
  opacity: number;
  delay: number;
  swayDelay: number;
};

const LEAF_COLORS = ["#34d399", "#4ade80", "#22c55e", "#6ee7b7", "#86efac"];
const BLOSSOM_COLORS = ["#fcd34d", "#fbbf24"];

function buildTree() {
  const rng = makeRng(0x5eed7ee);
  const branches: Branch[] = [];
  const leaves: Leaf[] = [];
  let branchId = 0;
  let leafId = 0;

  function addLeaves(x: number, y: number, depth: number, delay: number) {
    const count = depth === MAX_DEPTH ? 2 : 1;
    for (let i = 0; i < count; i++) {
      // Blossoms are rare warm accents; everything else is foliage.
      const isBlossom = rng() < 0.05;
      const palette = isBlossom ? BLOSSOM_COLORS : LEAF_COLORS;
      const size = isBlossom ? 2.2 + rng() * 1 : 2.8 + rng() * 2.2;
      leaves.push({
        id: leafId++,
        // Tight to the tip -- scattered wide, they read as confetti rather
        // than as foliage hanging off a twig.
        cx: x + (rng() - 0.5) * 7,
        cy: y + (rng() - 0.5) * 7,
        rx: isBlossom ? size : size * 0.62,
        ry: size,
        rotate: rng() * 360,
        fill: palette[Math.floor(rng() * palette.length)],
        opacity: 0.55 + rng() * 0.4,
        // Leaves unfurl just after the branch carrying them finishes.
        delay: delay + BRANCH_DURATION * 0.7 + rng() * 0.35,
        swayDelay: rng() * 4,
      });
    }
  }

  function grow(
    x: number,
    y: number,
    angleDeg: number,
    length: number,
    depth: number,
  ) {
    const rad = (angleDeg * Math.PI) / 180;
    const x2 = x + Math.cos(rad) * length;
    const y2 = y + Math.sin(rad) * length;

    // Bow each segment sideways a little -- a tree of dead-straight
    // segments reads as a diagram, not a plant.
    const bend = (rng() - 0.5) * length * 0.3;
    const mx = (x + x2) / 2 + Math.cos(rad + Math.PI / 2) * bend;
    const my = (y + y2) / 2 + Math.sin(rad + Math.PI / 2) * bend;

    const delay = depth * DEPTH_STEP;
    branches.push({
      id: branchId++,
      d: `M ${x.toFixed(2)} ${y.toFixed(2)} Q ${mx.toFixed(2)} ${my.toFixed(
        2,
      )} ${x2.toFixed(2)} ${y2.toFixed(2)}`,
      width: Math.max(0.6, 7 * Math.pow(0.71, depth)),
      opacity: 0.92 - depth * 0.06,
      delay,
    });

    if (depth >= LEAF_MIN_DEPTH) {
      addLeaves(x2, y2, depth, delay);
    }
    if (depth === MAX_DEPTH) return;

    // Narrower than the classic 30-degree fractal spread: at 7 levels a wide
    // spread accumulates into a crown that is far broader than it is tall
    // and gets clipped by the panel it sits in.
    const spread = 15 + rng() * 11;
    // Real trees aren't symmetric, and dropping a twig here also keeps the
    // element (and CSS-animation) count off the full 2^7.
    const dropped = depth >= 5 && rng() < 0.24 ? (rng() < 0.5 ? -1 : 1) : 0;
    for (const dir of [-1, 1]) {
      if (dir === dropped) continue;
      grow(
        x2,
        y2,
        angleDeg + dir * spread + (rng() - 0.5) * 8,
        length * (0.74 + rng() * 0.07),
        depth + 1,
      );
    }
  }

  grow(ROOT_X, ROOT_Y, -90, 88, 0);
  return { branches, leaves };
}

/** Generated once per module load, never per render. */
const { branches, leaves } = buildTree();

/** Slow drifting motes, for a bit of air around the crown. */
const motes = (() => {
  const rng = makeRng(0xd12f7);
  return Array.from({ length: 9 }, (_, i) => ({
    id: i,
    cx: 55 + rng() * 250,
    cy: 110 + rng() * 220,
    r: 1 + rng() * 1.6,
    delay: rng() * 9,
    duration: 11 + rng() * 8,
  }));
})();

export function GrowingTree({ className }: { className?: string }) {
  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      preserveAspectRatio="xMidYMax meet"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <radialGradient id="amiro-tree-glow" cx="50%" cy="42%" r="52%">
          <stop offset="0%" stopColor="#34d399" stopOpacity="0.16" />
          <stop offset="70%" stopColor="#34d399" stopOpacity="0.04" />
          <stop offset="100%" stopColor="#34d399" stopOpacity="0" />
        </radialGradient>
        <style>{`
          @keyframes amiro-tree-draw {
            from { stroke-dashoffset: 1; }
            to   { stroke-dashoffset: 0; }
          }
          /* Fades to var(--leaf-o), not to 1: a CSS animation's final
             keyframe beats both the presentation attribute and the inline
             style, so a hardcoded 1 here flattens every leaf to full
             opacity and the crown loses all its depth. */
          @keyframes amiro-tree-leaf-in {
            0%   { opacity: 0; transform: scale(0); }
            70%  { opacity: var(--leaf-o); transform: scale(1.15); }
            100% { opacity: var(--leaf-o); transform: scale(1); }
          }
          @keyframes amiro-tree-leaf-sway {
            0%, 100% { transform: translate(0, 0); }
            50%      { transform: translate(1.2px, -1.2px); }
          }
          @keyframes amiro-tree-sway {
            0%, 100% { transform: rotate(-0.65deg); }
            50%      { transform: rotate(0.65deg); }
          }
          @keyframes amiro-tree-glow-in {
            from { opacity: 0; }
            to   { opacity: 1; }
          }
          @keyframes amiro-tree-mote {
            0%   { opacity: 0; transform: translate(0, 10px); }
            25%  { opacity: 0.5; }
            75%  { opacity: 0.4; }
            100% { opacity: 0; transform: translate(10px, -34px); }
          }

          .amiro-tree-canopy {
            transform-box: view-box;
            transform-origin: ${ROOT_X}px ${ROOT_Y}px;
            animation: amiro-tree-sway 7s ${GROWTH_END}s ease-in-out infinite;
          }
          .amiro-tree-branch {
            fill: none;
            stroke: currentColor;
            stroke-linecap: round;
            stroke-dasharray: 1;
            stroke-dashoffset: 1;
            animation: amiro-tree-draw ${BRANCH_DURATION}s ease-out both;
          }
          .amiro-tree-leaf {
            transform-box: fill-box;
            transform-origin: center;
            opacity: 0;
            animation:
              amiro-tree-leaf-in 0.7s cubic-bezier(0.34, 1.4, 0.64, 1) both,
              amiro-tree-leaf-sway 5s ease-in-out infinite;
          }
          .amiro-tree-glow {
            opacity: 0;
            animation: amiro-tree-glow-in 2.2s ${GROWTH_END * 0.5}s ease-out forwards;
          }
          .amiro-tree-ground {
            opacity: 0;
            animation: amiro-tree-glow-in 1.2s 0.1s ease-out forwards;
          }
          .amiro-tree-mote {
            transform-box: fill-box;
            opacity: 0;
            animation: amiro-tree-mote linear infinite;
          }

          @media (prefers-reduced-motion: reduce) {
            .amiro-tree-canopy,
            .amiro-tree-branch,
            .amiro-tree-leaf,
            .amiro-tree-glow,
            .amiro-tree-ground,
            .amiro-tree-mote {
              animation: none !important;
              stroke-dashoffset: 0 !important;
              opacity: 1;
            }
            .amiro-tree-leaf { transform: none; }
          }
        `}</style>
      </defs>

      <ellipse
        className="amiro-tree-glow"
        cx={ROOT_X}
        cy={195}
        rx={165}
        ry={160}
        fill="url(#amiro-tree-glow)"
      />

      {/* The fade-in animation ends at opacity:1, which would beat the
          ellipse's own opacity attribute -- so the fade goes on a wrapping
          <g> and the faintness stays on the shape inside it. */}
      <g className="amiro-tree-ground">
        <ellipse
          cx={ROOT_X}
          cy={ROOT_Y + 6}
          rx={70}
          ry={6}
          fill="currentColor"
          opacity={0.12}
        />
      </g>

      <g className="amiro-tree-canopy">
        {branches.map((b) => (
          <path
            key={b.id}
            className="amiro-tree-branch"
            d={b.d}
            pathLength={1}
            strokeWidth={b.width}
            strokeOpacity={b.opacity}
            style={{ animationDelay: `${b.delay}s` }}
          />
        ))}

        {leaves.map((l) => (
          <ellipse
            key={l.id}
            className="amiro-tree-leaf"
            cx={l.cx}
            cy={l.cy}
            rx={l.rx}
            ry={l.ry}
            fill={l.fill}
            transform={`rotate(${l.rotate.toFixed(1)} ${l.cx.toFixed(
              2,
            )} ${l.cy.toFixed(2)})`}
            style={
              {
                // leaf-in then leaf-sway, so the two delays are positional.
                animationDelay: `${l.delay}s, ${GROWTH_END + l.swayDelay}s`,
                "--leaf-o": l.opacity,
              } as React.CSSProperties
            }
          />
        ))}
      </g>

      {motes.map((m) => (
        <circle
          key={m.id}
          className="amiro-tree-mote"
          cx={m.cx}
          cy={m.cy}
          r={m.r}
          fill="#6ee7b7"
          style={{
            animationDelay: `${GROWTH_END + m.delay}s`,
            animationDuration: `${m.duration}s`,
          }}
        />
      ))}
    </svg>
  );
}
