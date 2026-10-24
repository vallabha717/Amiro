import type { CharacterTraits } from "@/lib/agent/character-catalog";
import { AGENT_ACCENT } from "@/lib/agent/theme-colors";

/**
 * OpenDots plush mascots.
 *
 * The four "Dot" avatars are the MIT-licensed plush characters shipped by
 * CopilotKit/OpenDots at `public/dots/{blue,mint,orange,purple}.png`
 * (Copyright (c) Atai Barkai, MIT). The originals are copied verbatim into
 * `public/agent/opendots/`; see THIRD-PARTY-NOTICES.md.
 *
 * Amiro previously rendered an original dot-lattice body traced from radial
 * harmonic fields. That render has been replaced by these plush sprites, but
 * the persisted `CharacterTraits.bodyShape` ids are kept and mapped onto the
 * four variants so existing saved agents stay visually distinct and stable.
 */
export type OpenDotVariantId = "blue" | "mint" | "orange" | "purple";

export interface OpenDotVariant {
  id: OpenDotVariantId;
  /** Human-readable name, useful in pickers/aria copy. */
  label: string;
  /** Public URL served by Next.js from `public/agent/opendots/`. */
  src: string;
  /** Approximate base body colour, for swatches or fallbacks. */
  baseColor: string;
}

export const OPENDOTS_VARIANTS: readonly OpenDotVariant[] = [
  {
    id: "blue",
    label: "Blue",
    src: "/agent/opendots/blue.png",
    baseColor: "#778bed",
  },
  {
    id: "mint",
    label: "Mint",
    src: "/agent/opendots/mint.png",
    baseColor: "#7fd6b5",
  },
  {
    id: "orange",
    label: "Orange",
    src: "/agent/opendots/orange.png",
    baseColor: "#f2a35e",
  },
  {
    id: "purple",
    label: "Purple",
    src: "/agent/opendots/purple.png",
    baseColor: "#b48bec",
  },
] as const;

export const OPENDOTS_BY_ID: Record<OpenDotVariantId, OpenDotVariant> =
  Object.fromEntries(OPENDOTS_VARIANTS.map((v) => [v.id, v])) as Record<
    OpenDotVariantId,
    OpenDotVariant
  >;

export const OPENDOTS_DEFAULT_VARIANT: OpenDotVariant = OPENDOTS_BY_ID.blue;

/**
 * Default body tint. The plush bodies are recoloured with an SVG luminance
 * remap against this value, so the avatar follows the active theme accent by
 * default. Callers may pass an explicit `accentColor` to preview a pending
 * theme colour before it is committed.
 */
export const OPENDOTS_DEFAULT_TINT = AGENT_ACCENT;

/**
 * Persisted body-shape ids (6, from the retired lattice catalogue) folded onto
 * the four plush variants. Kept explicit rather than hashed so every existing
 * saved agent keeps the same character across reloads.
 */
const BODY_SHAPE_TO_VARIANT: Record<string, OpenDotVariantId> = {
  blob: "blue",
  urchin: "blue",
  sprout: "mint",
  star: "orange",
  cloud: "purple",
  ghost: "blue",
};

export function bodyShapeToVariant(
  bodyShape: string | null | undefined,
): OpenDotVariantId {
  if (!bodyShape) return OPENDOTS_DEFAULT_VARIANT.id;
  return BODY_SHAPE_TO_VARIANT[bodyShape] ?? OPENDOTS_DEFAULT_VARIANT.id;
}

export function openDotVariantForTraits(
  traits: Pick<CharacterTraits, "bodyShape"> | null | undefined,
): OpenDotVariant {
  return OPENDOTS_BY_ID[bodyShapeToVariant(traits?.bodyShape)];
}

export function openDotVariantById(
  id: string | null | undefined,
): OpenDotVariant {
  return OPENDOTS_BY_ID[id as OpenDotVariantId] ?? OPENDOTS_DEFAULT_VARIANT;
}
