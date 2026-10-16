"use client";

import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { animate, motion } from "framer-motion";
import {
  type CSSProperties,
  type ReactNode,
  type SVGProps,
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";

import {
  type AvatarTone,
  type BBox,
  type CharacterComponents,
  type CharacterTraits,
  DEFAULT_CHARACTER_TRAITS,
  DEFAULT_PERSONALITY_SLIDERS,
  type EyePathDefinition,
  PERSONALITY_AXES,
  PERSONALITY_AXIS_DEFAULT,
  eyeMarkColor,
  getCharacterComponents,
  pathBBox,
  toneForBg,
  unionBBox,
} from "@/lib/agent/character-catalog";
import {
  OPENDOTS_DEFAULT_TINT,
  openDotVariantForTraits,
} from "@/lib/agent/opendots-catalog";
import { cn } from "@/lib/utils";

/* -------------------------------------------------------------------------
   1. AgentCharacterAvatar
   ------------------------------------------------------------------------- */

/**
 * SVG2 `mask-type` is not in React's typings, so it is applied via a typed
 * attribute bag. Alpha masking keeps the plush sprite's cut-out silhouette.
 */
const MASK_ALPHA_PROPS = {
  "mask-type": "alpha",
} as unknown as SVGProps<SVGMaskElement>;

export interface AgentCharacterAvatarProps {
  traits?: CharacterTraits;
  /**
   * Retained for API compatibility with callers that still pass a character
   * catalogue. The plush render is driven solely by `traits.bodyShape`; this
   * prop is ignored.
   */
  components?: CharacterComponents;
  customImageUrl?: string | null;
  size?: number;
  interactive?: boolean;
  animated?: boolean;
  /**
   * Body tint for the plush sprite. Defaults to `var(--sidebar-primary)` so the
   * mascot follows the active theme accent; pass an explicit colour to preview
   * a pending theme before it is committed.
   */
  accentColor?: string;
  className?: string;
  style?: CSSProperties;
}

export function AgentCharacterAvatar({
  traits = DEFAULT_CHARACTER_TRAITS,
  customImageUrl,
  size = 120,
  interactive = false,
  animated = true,
  accentColor = OPENDOTS_DEFAULT_TINT,
  className,
  style,
}: AgentCharacterAvatarProps) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const reduce = prefersReducedMotion || !animated;

  const variant = useMemo(() => openDotVariantForTraits(traits), [traits]);
  // useId contains characters (e.g. ":r0:") that are invalid in a `url(#id)`
  // reference, so strip them before building the per-instance filter/mask ids.
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const grayId = `opendots-gray-${uid}`;
  const maskId = `opendots-mask-${uid}`;

  if (customImageUrl) {
    return (
      <motion.div
        className={cn(
          "relative overflow-hidden rounded-full border border-black/10 dark:border-white/10 shadow-sm",
          interactive && "cursor-pointer select-none",
          className,
        )}
        style={{ width: size, height: size, ...style }}
        animate={
          reduce
            ? undefined
            : {
                y: [0, -3, 0],
                scale: [1, 1.015, 1],
              }
        }
        transition={{
          duration: 4,
          repeat: Infinity,
          ease: "easeInOut",
        }}
        whileHover={interactive ? { scale: 1.05, rotate: 1.5 } : undefined}
        whileTap={interactive ? { scale: 0.98 } : undefined}
      >
        <img
          data-testid="agent-avatar"
          src={customImageUrl}
          alt="Agent avatar"
          className="h-full w-full object-cover"
          draggable={false}
        />
      </motion.div>
    );
  }

  return (
    <motion.div
      className={cn(
        "relative flex items-center justify-center select-none",
        interactive && "cursor-pointer",
        className,
      )}
      style={{ width: size, height: size, ...style }}
      animate={
        reduce
          ? undefined
          : {
              y: [0, -3, 0],
              scale: [1, 1.015, 1],
            }
      }
      transition={{
        duration: 4,
        repeat: Infinity,
        ease: "easeInOut",
      }}
      whileHover={interactive ? { scale: 1.05, rotate: 1.5 } : undefined}
      whileTap={interactive ? { scale: 0.98 } : undefined}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 512 512"
        role="img"
        aria-label="Agent avatar"
        data-testid="agent-avatar"
        style={{ display: "block" }}
      >
        <defs>
          {/* Grayscale first, so the tint below can remap luminance without
              dragging the sprite's own hue along. */}
          <filter id={grayId} colorInterpolationFilters="sRGB">
            <feColorMatrix type="saturate" values="0" />
          </filter>
          {/* Alpha mask keeps the plush cut-out: transparent corners stay
              transparent instead of taking the tint colour. */}
          <mask
            id={maskId}
            maskUnits="userSpaceOnUse"
            x={0}
            y={0}
            width={512}
            height={512}
            {...MASK_ALPHA_PROPS}
          >
            <image
              href={variant.src}
              x={0}
              y={0}
              width={512}
              height={512}
              preserveAspectRatio="xMidYMid meet"
            />
          </mask>
        </defs>
        <g style={{ isolation: "isolate" }}>
          <image
            href={variant.src}
            x={0}
            y={0}
            width={512}
            height={512}
            preserveAspectRatio="xMidYMid meet"
            filter={`url(#${grayId})`}
          />
          {/* `mix-blend-mode: color` takes the tint's hue/saturation and keeps
              the sprite's luminance, so the glossy black eyes, soft shading
              and white highlights are preserved while the body follows the
              accent. */}
          <rect
            x={0}
            y={0}
            width={512}
            height={512}
            fill={accentColor}
            mask={`url(#${maskId})`}
            style={{ mixBlendMode: "color" }}
          />
        </g>
      </svg>
    </motion.div>
  );
}

/* -------------------------------------------------------------------------
   2. AmoebaPeekTab
   ------------------------------------------------------------------------- */

export type AmoebaFacing = "top" | "bottom" | "left" | "right";

export interface AmoebaRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface AmoebaTarget {
  rect: AmoebaRect;
  facing: AmoebaFacing;
  peek: { x: number; y: number };
}

const PEEK_EDGE_MARGIN = 96;
const TAB_DIAMETER = 150;
const EYE_INSET = 36;
const RETRACT_PX = 46;
const EYE_W = 58;

const clamp = (n: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, n));

/**
 * Eye art can be a single thin arc, whose bbox aspect would be degenerate once
 * it is scaled into the peek tab / stage. Keep it inside a sane band.
 */
function safeAspect(bbox: BBox): number {
  if (!(bbox.w > 0) || !(bbox.h > 0)) {
    return 0.7;
  }
  return clamp(bbox.h / bbox.w, 0.32, 1);
}

/** One eye mark, resolved against the aura tone and stroked when required. */
function EyeMark({
  mark,
  tone,
  transform,
}: {
  mark: EyePathDefinition;
  tone: AvatarTone;
  transform?: string;
}) {
  const paint = eyeMarkColor(mark.color, tone);
  if (mark.strokeWidth) {
    return (
      <path
        d={mark.svgPath}
        fill="none"
        stroke={paint}
        strokeWidth={mark.strokeWidth}
        strokeLinecap="round"
        transform={transform}
      />
    );
  }
  return <path d={mark.svgPath} fill={paint} transform={transform} />;
}

export function amoebaTargetForCard(
  card: AmoebaRect,
  facing: AmoebaFacing,
  containerCenter: { x: number; y: number },
): AmoebaTarget {
  const alongX = clamp(
    containerCenter.x - card.left,
    PEEK_EDGE_MARGIN,
    card.width - PEEK_EDGE_MARGIN,
  );
  const alongY = clamp(
    containerCenter.y - card.top,
    PEEK_EDGE_MARGIN,
    card.height - PEEK_EDGE_MARGIN,
  );
  const peek =
    facing === "top"
      ? { x: alongX, y: 0 }
      : facing === "bottom"
        ? { x: alongX, y: card.height }
        : facing === "left"
          ? { x: 0, y: alongY }
          : { x: card.width, y: alongY };
  return { rect: card, facing, peek };
}

const OUTWARD: Record<AmoebaFacing, { x: number; y: number }> = {
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

const TAB_SPRING = {
  type: "spring" as const,
  stiffness: 150,
  damping: 19,
};

const TAB_IN_DELAY_S = 0.22;
const TAB_OUT_S = 0.15;

export interface AmoebaPeekTabProps {
  hex: string;
  components?: CharacterComponents;
  traits?: CharacterTraits;
  target: AmoebaTarget | null;
}

export function AmoebaPeekTab({
  hex,
  components,
  traits = DEFAULT_CHARACTER_TRAITS,
  target,
}: AmoebaPeekTabProps) {
  const allComponents = useMemo(
    () => components ?? getCharacterComponents(),
    [components],
  );
  const eyeTone = toneForBg(hex);
  const active = target !== null;

  const [lastTarget, setLastTarget] = useState<AmoebaTarget | null>(null);
  if (target && target !== lastTarget) {
    setLastTarget(target);
  }
  const geo = target ?? lastTarget;

  const [blinking, setBlinking] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let t: ReturnType<typeof setTimeout>;
    const idle = () => {
      t = setTimeout(
        () => {
          if (cancelled) return;
          setBlinking(true);
          t = setTimeout(() => {
            if (cancelled) return;
            setBlinking(false);
            idle();
          }, 140);
        },
        2500 + Math.random() * 4000,
      );
    };
    idle();
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, []);

  const eye = useMemo(() => {
    const def = allComponents.eyeStyles.find((e) => e.id === traits.eyeStyle);
    if (!def) return null;
    return {
      paths: def.paths,
      bbox: unionBBox(def.paths.map((p) => pathBBox(p.svgPath))),
    };
  }, [allComponents, traits.eyeStyle]);

  if (!eye || !geo) {
    return null;
  }

  const { rect, facing, peek } = geo;
  const anchor = { x: rect.left + peek.x, y: rect.top + peek.y };
  const out = OUTWARD[facing];

  const aspect = safeAspect(eye.bbox);
  const eyeW = EYE_W;
  const eyeH = eyeW * aspect;
  const eyeCenter = {
    x: anchor.x + out.x * EYE_INSET,
    y: anchor.y + out.y * EYE_INSET,
  };
  const retract = { x: -out.x * RETRACT_PX, y: -out.y * RETRACT_PX };

  const eyeCx = eye.bbox.x + eye.bbox.w / 2;
  const eyeCy = eye.bbox.y + eye.bbox.h / 2;

  const transition = active
    ? {
        ...TAB_SPRING,
        delay: TAB_IN_DELAY_S,
        opacity: { duration: 0.15, delay: TAB_IN_DELAY_S },
      }
    : { duration: TAB_OUT_S };

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-0 overflow-hidden"
    >
      <motion.div
        className="absolute top-0 left-0 rounded-full"
        style={{
          backgroundColor: hex,
          width: TAB_DIAMETER,
          height: TAB_DIAMETER,
        }}
        initial={false}
        animate={{
          x: anchor.x - TAB_DIAMETER / 2 + (active ? 0 : retract.x),
          y: anchor.y - TAB_DIAMETER / 2 + (active ? 0 : retract.y),
          opacity: active ? 1 : 0,
        }}
        transition={transition}
      />
      <motion.div
        className="absolute top-0 left-0"
        initial={false}
        animate={{
          x: eyeCenter.x - eyeW / 2 + (active ? 0 : retract.x),
          y: eyeCenter.y - eyeH / 2 + (active ? 0 : retract.y),
          width: eyeW,
          height: eyeH,
          opacity: active ? 1 : 0,
        }}
        transition={transition}
      >
        <svg
          viewBox={`${eye.bbox.x} ${eye.bbox.y} ${eye.bbox.w} ${eye.bbox.h}`}
          width="100%"
          height="100%"
          preserveAspectRatio="xMidYMid meet"
          style={{ overflow: "visible", display: "block" }}
        >
          <g
            style={{
              transform: blinking ? "scaleY(0.1)" : "scaleY(1)",
              transformOrigin: `${eyeCx}px ${eyeCy}px`,
              transition: "transform 0.14s ease-in-out",
            }}
          >
            {eye.paths.map((p, i) => (
              <EyeMark key={i} mark={p} tone={eyeTone} />
            ))}
          </g>
        </svg>
      </motion.div>
    </div>
  );
}

/* -------------------------------------------------------------------------
   3. AssistantStage & useAssistantStage
   ------------------------------------------------------------------------- */

export interface StageSize {
  w: number;
  h: number;
}

export interface AssistantStageValue {
  stage: StageSize;
  tone: AvatarTone;
  bottomReserve: number;
}

const AssistantStageContext = createContext<AssistantStageValue | null>(null);

export function useAssistantStage(): AssistantStageValue {
  const ctx = useContext(AssistantStageContext);
  if (!ctx) {
    throw new Error("useAssistantStage must be used inside <AssistantStage>");
  }
  return ctx;
}

const EYE_REST_CUTOFF = 0.25;
const EYE_DIP_CUTOFF = 0.46;
const EYE_TARGET_HEIGHT = 0.3;
const EYE_MAX_WIDTH = 0.85;
const STAGE_CENTER_FRACTION = 0.4;
const EYES_VISIBLE_FRACTION = EYE_TARGET_HEIGHT * (1 - EYE_REST_CUTOFF);

const IMAGE_BOTTOM_MARGIN = 24;
const IMAGE_TARGET_FRACTION = 0.2;
const IMAGE_MIN_PX = 96;
const IMAGE_MAX_PX = 160;

export interface AssistantStageProps {
  components?: CharacterComponents | null;
  traits?: CharacterTraits | null;
  customImageUrl?: string | null;
  accentHex?: string | null;
  entrance?: boolean;
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export function AssistantStage({
  components,
  traits,
  customImageUrl,
  accentHex,
  entrance = false,
  children,
  className,
  style,
}: AssistantStageProps) {
  const [stageRef, setStageRef] = useState<HTMLElement | null>(null);
  const [size, setSize] = useState<StageSize>({ w: 800, h: 600 });

  useLayoutEffect(() => {
    if (!stageRef) return;
    const measure = () => {
      const rect = stageRef.getBoundingClientRect();
      setSize((prev) =>
        prev.w === rect.width && prev.h === rect.height
          ? prev
          : { w: rect.width, h: rect.height },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stageRef);
    return () => observer.disconnect();
  }, [stageRef]);

  const bg = accentHex ?? "#17191C";
  const tone = toneForBg(bg);

  const showEyes = Boolean(!customImageUrl && (components || traits));
  const showImage = !showEyes && Boolean(customImageUrl);

  const imageSize = Math.round(
    Math.min(
      IMAGE_MAX_PX,
      Math.max(IMAGE_MIN_PX, Math.min(size.w, size.h) * IMAGE_TARGET_FRACTION),
    ),
  );
  const imageRestTop = size.h - imageSize - IMAGE_BOTTOM_MARGIN;

  const bottomReserve = showEyes
    ? Math.round(EYES_VISIBLE_FRACTION * Math.min(size.w, size.h)) + 16
    : showImage
      ? imageSize + IMAGE_BOTTOM_MARGIN + 16
      : 24;

  const allComponents = useMemo(
    () => components ?? getCharacterComponents(),
    [components],
  );
  const activeTraits = traits ?? DEFAULT_CHARACTER_TRAITS;

  const eyeArt = useMemo(() => {
    if (!showEyes) return null;
    const def = allComponents.eyeStyles.find(
      (e) => e.id === activeTraits.eyeStyle,
    );
    if (!def) return null;
    return {
      paths: def.paths,
      bbox: unionBBox(def.paths.map((p) => pathBBox(p.svgPath))),
    };
  }, [showEyes, allComponents, activeTraits.eyeStyle]);

  return (
    <div
      ref={setStageRef}
      className={cn(
        "relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-black/10 dark:border-white/10",
        className,
      )}
      style={{ backgroundColor: bg, color: tone.fg, ...style }}
    >
      {showEyes && eyeArt && size.w > 0 && size.h > 0 && (
        <PeekingEyesInternal
          art={eyeArt}
          tone={tone}
          stage={size}
          entrance={entrance}
        />
      )}

      {showImage && customImageUrl && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute z-[2] overflow-hidden rounded-full ring-4 ring-white/25 shadow-lg"
          style={{
            left: (size.w - imageSize) / 2,
            top: imageRestTop,
            width: imageSize,
            height: imageSize,
          }}
        >
          <img
            src={customImageUrl}
            alt=""
            className="h-full w-full object-cover"
            draggable={false}
          />
        </div>
      )}

      <AssistantStageContext.Provider
        value={{ stage: size, tone, bottomReserve }}
      >
        <div className="relative z-10 flex min-h-0 flex-1 flex-col">
          {children}
        </div>
      </AssistantStageContext.Provider>
    </div>
  );
}

interface PeekingEyesInternalProps {
  art: { paths: EyePathDefinition[]; bbox: BBox };
  tone: AvatarTone;
  stage: StageSize;
  entrance?: boolean;
}

function PeekingEyesInternal({
  art,
  tone,
  stage,
  entrance = false,
}: PeekingEyesInternalProps) {
  const reduce = usePrefersReducedMotion();
  const { w, h } = stage;

  const [blinking, setBlinking] = useState(false);
  const [entranceDone, setEntranceDone] = useState(!entrance);

  useEffect(() => {
    if (reduce || !entranceDone) return;
    let cancelled = false;
    let t: ReturnType<typeof setTimeout>;

    const blink = (next: () => void) => {
      if (cancelled) return;
      setBlinking(true);
      t = setTimeout(() => {
        if (cancelled) return;
        setBlinking(false);
        t = setTimeout(next, 140);
      }, 140);
    };

    const idle = () => {
      t = setTimeout(() => blink(idle), 2500 + Math.random() * 4000);
    };

    if (entrance) {
      blink(() => blink(idle));
    } else {
      idle();
    }

    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [reduce, entranceDone, entrance]);

  const maxEyesW = w * EYE_MAX_WIDTH;
  const aspect = safeAspect(art.bbox);
  const eyesH = Math.min(Math.min(w, h) * EYE_TARGET_HEIGHT, maxEyesW * aspect);
  const eyesW = eyesH / aspect;
  const eyesLeft = (w - eyesW) / 2;
  const eyesRestTop = h - (1 - EYE_REST_CUTOFF) * eyesH;
  const eyesStartY = STAGE_CENTER_FRACTION * h - (eyesRestTop + eyesH / 2);
  const eyesDipY = (EYE_DIP_CUTOFF - EYE_REST_CUTOFF) * eyesH;
  const eyeCx = art.bbox.x + art.bbox.w / 2;
  const eyeCy = art.bbox.y + art.bbox.h / 2;

  const playEntrance = entrance && !reduce;

  return (
    <motion.div
      aria-hidden="true"
      className="pointer-events-none absolute z-[2]"
      style={{
        left: eyesLeft,
        top: eyesRestTop,
        width: eyesW,
        height: eyesH,
        transformOrigin: "center",
      }}
      initial={playEntrance ? { y: eyesStartY, scale: 0.35 } : false}
      animate={
        playEntrance
          ? { y: [eyesStartY, eyesDipY, 0], scale: [0.35, 1, 1] }
          : { y: 0, scale: 1 }
      }
      transition={
        playEntrance
          ? {
              duration: 1,
              times: [0, 0.7, 1],
              ease: "easeInOut",
            }
          : { duration: 0 }
      }
      onAnimationComplete={() => setEntranceDone(true)}
    >
      <svg
        viewBox={`${art.bbox.x} ${art.bbox.y} ${art.bbox.w} ${art.bbox.h}`}
        width={eyesW}
        height={eyesH}
        style={{ overflow: "visible", display: "block" }}
      >
        <g
          style={{
            transform: blinking ? "scaleY(0.1)" : "scaleY(1)",
            transformOrigin: `${eyeCx}px ${eyeCy}px`,
            transition: "transform 0.14s ease-in-out",
          }}
        >
          {art.paths.map((p, i) => (
            <EyeMark key={i} mark={p} tone={tone} />
          ))}
        </g>
      </svg>
    </motion.div>
  );
}

/* -------------------------------------------------------------------------
   4. PersonalitySignature
   ------------------------------------------------------------------------- */

const SIG_W = 340;
const SIG_PAD_X = 46;
const SIG_LINE_H = 11.5;
const SIG_DEAD_ZONE = 5;
const SIG_CAP_W = 10;
const SIG_NEUTRAL_OPACITY = 0.42;
const SIG_FADED_OPACITY = 0.26;

interface SignatureFrame {
  h: number;
  mid: number;
  span: number;
  topY: number;
  bottomY: number;
}

const FULL_FRAME: SignatureFrame = {
  h: 226,
  mid: 113,
  span: 58,
  topY: 15,
  bottomY: 216,
};

const COMPACT_FRAME: SignatureFrame = {
  h: 108,
  mid: 52,
  span: 18,
  topY: 12,
  bottomY: 96,
};

const XS = PERSONALITY_AXES.map(
  (_, i) =>
    SIG_PAD_X + (i * (SIG_W - SIG_PAD_X * 2)) / (PERSONALITY_AXES.length - 1),
);

function sigAxisValue(values: Record<string, number>, id: string): number {
  const kebab = id.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
  const n = values[id] ?? values[kebab] ?? PERSONALITY_AXIS_DEFAULT;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function yForSig(value: number, frame: SignatureFrame): number {
  return frame.mid - ((value - 50) / 50) * frame.span;
}

function poleLines(label: string): string[] {
  return label.length > 8 && label.includes(" ") ? label.split(" ") : [label];
}

interface PoleLabelProps {
  x: number;
  label: string;
  frame: SignatureFrame;
  above: boolean;
  leaning: boolean;
  neutral: boolean;
  magnitude: number;
}

function PoleLabel({
  x,
  label,
  frame,
  above,
  leaning,
  neutral,
  magnitude,
}: PoleLabelProps) {
  const rows = poleLines(label);
  const y = above ? frame.topY : frame.bottomY - (rows.length - 1) * SIG_LINE_H;
  const strong = leaning && !neutral;
  const opacity = neutral
    ? SIG_NEUTRAL_OPACITY
    : strong
      ? 0.62 + 0.38 * magnitude
      : SIG_FADED_OPACITY;

  return (
    <text
      x={x}
      y={y}
      textAnchor="middle"
      fontSize={10}
      fontWeight={strong ? 600 : 400}
      fill="currentColor"
      fillOpacity={opacity}
    >
      {rows.map((row, i) => (
        <tspan key={row} x={x} dy={i === 0 ? 0 : SIG_LINE_H}>
          {row}
        </tspan>
      ))}
    </text>
  );
}

export interface PersonalitySignatureProps {
  values?: Record<string, number>;
  compact?: boolean;
  accentColor?: string;
  className?: string;
  style?: CSSProperties;
}

export function PersonalitySignature({
  values = DEFAULT_PERSONALITY_SLIDERS,
  compact = false,
  accentColor,
  className,
  style,
}: PersonalitySignatureProps) {
  const reduce = usePrefersReducedMotion();
  const frame = compact ? COMPACT_FRAME : FULL_FRAME;

  const axes = PERSONALITY_AXES.map((axis) => {
    const value = sigAxisValue(values, axis.id);
    const lean = value - 50;
    const neutral = Math.abs(lean) <= SIG_DEAD_ZONE;
    return {
      axis,
      left: axis.left,
      right: axis.right,
      value,
      lean,
      neutral,
      magnitude: Math.abs(lean) / 50,
    };
  });

  const [grown, setGrown] = useState(reduce ? 1 : 0);
  useEffect(() => {
    if (reduce) {
      setGrown(1);
      return;
    }
    const controls = animate(0, 1, {
      type: "spring",
      stiffness: 140,
      damping: 16,
      onUpdate: setGrown,
    });
    return () => controls.stop();
  }, [reduce]);

  const ys = axes.map((a) => yForSig(50 + (a.value - 50) * grown, frame));

  return (
    <svg
      viewBox={`0 0 ${SIG_W} ${frame.h}`}
      role="img"
      aria-label="Personality signature"
      className={cn("w-full max-w-full select-none", className)}
      style={style}
    >
      <line
        x1={SIG_PAD_X - 14}
        y1={frame.mid}
        x2={SIG_W - SIG_PAD_X + 14}
        y2={frame.mid}
        stroke="currentColor"
        strokeOpacity={0.3}
        strokeWidth={1}
        strokeDasharray="2 4"
      />

      {axes.map(({ axis }, i) => (
        <rect
          key={axis.id}
          x={XS[i]! - SIG_CAP_W / 2}
          y={Math.min(frame.mid, ys[i]!) - SIG_CAP_W / 2}
          width={SIG_CAP_W}
          height={Math.abs(ys[i]! - frame.mid) + SIG_CAP_W}
          rx={SIG_CAP_W / 2}
          fill={accentColor ?? "var(--card-accent, currentColor)"}
        />
      ))}

      {axes.map(({ axis, left, right, lean, neutral, magnitude }, i) => (
        <g key={axis.id}>
          <PoleLabel
            x={XS[i]!}
            label={right}
            frame={frame}
            above
            leaning={lean > 0}
            neutral={neutral}
            magnitude={magnitude}
          />
          <PoleLabel
            x={XS[i]!}
            label={left}
            frame={frame}
            above={false}
            leaning={lean < 0}
            neutral={neutral}
            magnitude={magnitude}
          />
        </g>
      ))}
    </svg>
  );
}
