"use client";

import {
  type AgentIdentity,
  updateAgentIdentity,
  useInvalidateAgentIdentity,
} from "@/hooks/queries/use-agent-identity";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import {
  AVATAR_COLORS,
  type CharacterTraits,
  accentHexForColorId,
  getCharacterComponents,
} from "@/lib/agent/character-catalog";
import { motion } from "framer-motion";
import { cn } from "lib/utils";
import {
  AlertCircle,
  Check,
  ChevronLeft,
  ChevronRight,
  Dices,
  ImagePlus,
  RotateCcw,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "ui/dialog";
import { Input } from "ui/input";
import { Label } from "ui/label";
import { AgentCharacterAvatar } from "./avatar-primitives";

const BODY_LABELS: Record<string, string> = {
  blob: "Amoeba",
  cloud: "Nimbus",
  sprout: "Sprout",
  star: "Nova",
  ghost: "Specter",
  urchin: "Urchin",
};

const EYE_LABELS: Record<string, string> = {
  round: "Curious",
  happy: "Warm",
  sleepy: "Mellow",
  wink: "Playful",
  curious: "Focused",
  sparkle: "Radiant",
  default: "Expressive",
};

const ALLOWED_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"];

// The catalog id is "cobalt". "blue" was an earlier alias for that same swatch.
// Stored identities, the character catalog and the adapter all accept only
// "cobalt", so every read and write resolves through here. Sending the alias
// was a real bug: the adapter rejected "blue" as an unknown trait.
function resolveColorId(colorId: string): string {
  return colorId === "blue" ? "cobalt" : colorId;
}
const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2 MB

interface AgentCustomizerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  identity: AgentIdentity;
}

export function AgentCustomizerModal({
  open,
  onOpenChange,
  identity,
}: AgentCustomizerModalProps) {
  const reduceMotion = usePrefersReducedMotion();
  const invalidate = useInvalidateAgentIdentity();
  const components = getCharacterComponents();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [name, setName] = useState(identity.name);
  const [tagline, setTagline] = useState(identity.tagline);
  const [bodyShape, setBodyShape] = useState(identity.traits.bodyShape);
  const [eyeStyle, setEyeStyle] = useState(identity.traits.eyeStyle);
  const [color, setColor] = useState(resolveColorId(identity.traits.color));
  const [customImageUrl, setCustomImageUrl] = useState<string | null>(
    identity.customImageUrl,
  );
  const [saving, setSaving] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(identity.name);
      setTagline(identity.tagline);
      setBodyShape(identity.traits.bodyShape);
      setEyeStyle(identity.traits.eyeStyle);
      setColor(resolveColorId(identity.traits.color));
      setCustomImageUrl(identity.customImageUrl);
      setValidationError(null);
    }
  }, [open, identity]);

  const resolvedColorId = resolveColorId(color);
  const activeHex =
    accentHexForColorId(resolvedColorId) || identity.accentHex || "#E9642F";

  const cycleTrait = useCallback(
    (list: Array<{ id: string }>, current: string, dir: 1 | -1) => {
      if (!list.length) return current;
      const idx = Math.max(
        0,
        list.findIndex((item) => item.id === current),
      );
      const nextIdx = (idx + dir + list.length) % list.length;
      return list[nextIdx]!.id;
    },
    [],
  );

  const handleRandomize = useCallback(() => {
    setValidationError(null);
    const b =
      components.bodyShapes[
        Math.floor(Math.random() * components.bodyShapes.length)
      ]?.id ?? bodyShape;
    const e =
      components.eyeStyles[
        Math.floor(Math.random() * components.eyeStyles.length)
      ]?.id ?? eyeStyle;
    const c =
      AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)]?.id ??
      color;
    setCustomImageUrl(null);
    setBodyShape(b);
    setEyeStyle(e);
    setColor(c);
  }, [components, bodyShape, eyeStyle, color]);

  const handleImageUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setValidationError(null);
      const file = e.target.files?.[0];
      if (!file) return;

      const mime = file.type.toLowerCase();
      if (!ALLOWED_IMAGE_MIME_TYPES.includes(mime)) {
        const msg = "Please choose a PNG, JPEG, or WebP image.";
        setValidationError(msg);
        toast.error(msg);
        if (fileInputRef.current) fileInputRef.current.value = "";
        return;
      }

      if (file.size > MAX_IMAGE_BYTES) {
        const msg = "Image size exceeds 2 MB limit.";
        setValidationError(msg);
        toast.error(msg);
        if (fileInputRef.current) fileInputRef.current.value = "";
        return;
      }

      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === "string") {
          // Double check base64 data URL
          const resultStr = reader.result;
          if (!/^data:image\/(png|jpeg|webp);base64,/i.test(resultStr)) {
            const msg = "Only PNG, JPEG, or WebP images are allowed.";
            setValidationError(msg);
            toast.error(msg);
            return;
          }
          setCustomImageUrl(resultStr);
        }
      };
      reader.onerror = () => {
        const msg = "Failed to read the image file.";
        setValidationError(msg);
        toast.error(msg);
      };
      reader.readAsDataURL(file);
    },
    [],
  );

  const handleSave = async () => {
    setValidationError(null);
    const trimmedName = name.trim();
    if (!trimmedName) {
      const msg = "Agent name cannot be blank.";
      setValidationError(msg);
      toast.error(msg);
      return;
    }
    if (trimmedName.length > 32) {
      const msg = "Agent name must be 32 characters or fewer.";
      setValidationError(msg);
      toast.error(msg);
      return;
    }

    // Validate data image url if present
    if (customImageUrl) {
      if (customImageUrl.startsWith("data:")) {
        const commaIdx = customImageUrl.indexOf(",");
        if (commaIdx === -1) {
          const msg = "Invalid image data format.";
          setValidationError(msg);
          toast.error(msg);
          return;
        }
        const header = customImageUrl.slice(0, commaIdx);
        const b64 = customImageUrl.slice(commaIdx + 1);
        if (!/^data:image\/(png|jpeg|webp);base64$/i.test(header)) {
          const msg = "Only PNG, JPEG, and WebP data images are allowed.";
          setValidationError(msg);
          toast.error(msg);
          return;
        }
        const approxBytes = Math.ceil((b64.length * 3) / 4);
        if (approxBytes > MAX_IMAGE_BYTES) {
          const msg = "Image data exceeds the 2 MB limit.";
          setValidationError(msg);
          toast.error(msg);
          return;
        }
      }
    }

    setSaving(true);
    try {
      const traits: CharacterTraits = {
        bodyShape,
        eyeStyle,
        color: resolvedColorId,
      };
      await updateAgentIdentity({
        name: trimmedName,
        tagline:
          tagline.trim() || "Your Personal Intelligence powered by Jcode",
        traits,
        accentHex: accentHexForColorId(resolvedColorId) ?? "#E9642F",
        customImageUrl,
      });
      await invalidate();
      toast.success(`Say hi to ${trimmedName}!`);
      onOpenChange(false);
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : "Could not save agent customization.";
      setValidationError(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="agent-customizer-modal"
        style={{
          fontFamily:
            "var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif",
        }}
        className="max-w-xl overflow-hidden rounded-3xl border border-border/70 bg-background/95 p-0 shadow-2xl backdrop-blur-2xl"
      >
        {/* Top stage preview with live reactive glow */}
        <div
          className="relative flex flex-col items-center justify-center overflow-hidden px-6 pt-8 pb-6 transition-colors duration-300"
          style={{
            background: `radial-gradient(120% 95% at 50% 0%, color-mix(in srgb, ${activeHex} 28%, transparent) 0%, transparent 78%)`,
          }}
        >
          <DialogHeader className="z-10 mb-3 text-center">
            <DialogTitle className="font-brand text-2xl font-semibold tracking-tight">
              Customize Your Agent
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              Shape their look, color signature, and name across Amiro and Jcode
            </DialogDescription>
          </DialogHeader>

          <motion.div
            key={`${bodyShape}-${eyeStyle}-${resolvedColorId}-${Boolean(customImageUrl)}`}
            initial={reduceMotion ? false : { scale: 0.92, opacity: 0.6 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: "spring", stiffness: 260, damping: 20 }}
            className="relative my-2 flex items-center justify-center"
            role="img"
            aria-label={`Preview of ${name || "Agent"} with ${BODY_LABELS[bodyShape] ?? bodyShape} form, ${EYE_LABELS[eyeStyle] ?? eyeStyle} gaze, and ${resolvedColorId} aura`}
          >
            <div
              className="pointer-events-none absolute -inset-6 rounded-full opacity-35 blur-2xl transition-colors duration-300"
              style={{ backgroundColor: activeHex }}
            />
            <AgentCharacterAvatar
              traits={{ bodyShape, eyeStyle, color: resolvedColorId }}
              customImageUrl={customImageUrl}
              size={148}
              interactive
            />
          </motion.div>

          {/* Quick action pills under avatar */}
          <div className="z-10 mt-3 flex flex-wrap items-center justify-center gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={handleRandomize}
              data-testid="agent-customizer-randomize"
              aria-label="Surprise me with random traits"
              className="h-8 gap-1.5 rounded-full px-3.5 text-xs font-medium shadow-xs"
            >
              <Dices className="size-3.5" aria-hidden="true" />
              Surprise me
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={handleImageUpload}
              aria-label="Upload custom portrait in PNG, JPEG, or WebP format up to 2 MB"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              aria-label="Upload Portrait in PNG, JPEG, or WebP up to 2 MB"
              className="h-8 gap-1.5 rounded-full bg-background/60 px-3.5 text-xs font-medium backdrop-blur-md"
            >
              <ImagePlus className="size-3.5" aria-hidden="true" />
              Upload Portrait
            </Button>
            {customImageUrl && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setCustomImageUrl(null);
                  setValidationError(null);
                }}
                aria-label="Remove custom image and revert to character avatar"
                className="h-8 gap-1 rounded-full px-3 text-xs text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
                Use Character
              </Button>
            )}
          </div>
        </div>

        {/* Validation error banner if any */}
        {validationError ? (
          <div
            role="alert"
            aria-live="assertive"
            className="mx-6 mt-3 flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
            <span>{validationError}</span>
          </div>
        ) : null}

        {/* Controls body */}
        <div className="flex flex-col gap-5 px-6 pt-2 pb-6">
          {/* Identity Name & Tagline */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="agent-name-input" className="text-xs font-medium">
                Agent Name
              </Label>
              <Input
                id="agent-name-input"
                data-testid="agent-name-input"
                value={name}
                maxLength={32}
                aria-required="true"
                aria-invalid={!name.trim()}
                onChange={(e) => {
                  setName(e.target.value);
                  if (validationError) setValidationError(null);
                }}
                placeholder="Amiro…"
                autoComplete="off"
                className="h-9 rounded-xl"
              />
            </div>
            <div className="space-y-1.5">
              <Label
                htmlFor="agent-tagline-input"
                className="text-xs font-medium"
              >
                Role & Signature Line
              </Label>
              <Input
                id="agent-tagline-input"
                data-testid="agent-tagline-input"
                value={tagline}
                maxLength={120}
                onChange={(e) => setTagline(e.target.value)}
                placeholder="Your Personal Intelligence…"
                autoComplete="off"
                className="h-9 rounded-xl"
              />
            </div>
          </div>

          {/* Body Shape & Eye Expression cyclers */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex items-center justify-between rounded-2xl border border-border/60 bg-muted/30 px-3.5 py-2.5">
              <div className="min-w-0">
                <p className="text-[11px] font-medium text-muted-foreground">
                  Form
                </p>
                <p className="truncate text-sm font-semibold capitalize">
                  {BODY_LABELS[bodyShape] ?? bodyShape}
                </p>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  aria-label="Previous form"
                  onClick={() => {
                    setCustomImageUrl(null);
                    setBodyShape(
                      cycleTrait(components.bodyShapes, bodyShape, -1),
                    );
                  }}
                  className="flex size-7 items-center justify-center rounded-full border border-border/60 bg-background/80 text-foreground transition-transform hover:bg-accent active:scale-95 focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ChevronLeft className="size-4" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-label="Next form"
                  data-testid="agent-next-body-shape"
                  onClick={() => {
                    setCustomImageUrl(null);
                    setBodyShape(
                      cycleTrait(components.bodyShapes, bodyShape, 1),
                    );
                  }}
                  className="flex size-7 items-center justify-center rounded-full border border-border/60 bg-background/80 text-foreground transition-transform hover:bg-accent active:scale-95 focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ChevronRight className="size-4" aria-hidden="true" />
                </button>
              </div>
            </div>

            <div className="flex items-center justify-between rounded-2xl border border-border/60 bg-muted/30 px-3.5 py-2.5">
              <div className="min-w-0">
                <p className="text-[11px] font-medium text-muted-foreground">
                  Gaze
                </p>
                <p className="truncate text-sm font-semibold capitalize">
                  {EYE_LABELS[eyeStyle] ?? eyeStyle}
                </p>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  aria-label="Previous gaze"
                  onClick={() => {
                    setCustomImageUrl(null);
                    setEyeStyle(cycleTrait(components.eyeStyles, eyeStyle, -1));
                  }}
                  className="flex size-7 items-center justify-center rounded-full border border-border/60 bg-background/80 text-foreground transition-transform hover:bg-accent active:scale-95 focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ChevronLeft className="size-4" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-label="Next gaze"
                  data-testid="agent-next-eye-style"
                  onClick={() => {
                    setCustomImageUrl(null);
                    setEyeStyle(cycleTrait(components.eyeStyles, eyeStyle, 1));
                  }}
                  className="flex size-7 items-center justify-center rounded-full border border-border/60 bg-background/80 text-foreground transition-transform hover:bg-accent active:scale-95 focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ChevronRight className="size-4" aria-hidden="true" />
                </button>
              </div>
            </div>
          </div>

          {/* Signature Color Swatches */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">Aura & Stage Tint</span>
              <span className="font-mono text-[11px] text-muted-foreground">
                {activeHex}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2.5">
              {AVATAR_COLORS.map((swatch) => {
                const isSelected = resolvedColorId === swatch.id;
                return (
                  <button
                    key={swatch.id}
                    type="button"
                    aria-label={`Select ${swatch.id} aura`}
                    aria-pressed={isSelected}
                    data-testid={`agent-color-${swatch.id}`}
                    onClick={() => {
                      setColor(swatch.id);
                    }}
                    className={cn(
                      "relative flex size-9 items-center justify-center rounded-full transition-transform hover:scale-105 active:scale-95 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                      isSelected &&
                        "ring-2 ring-foreground ring-offset-2 ring-offset-background",
                    )}
                    style={{ backgroundColor: swatch.hex }}
                  >
                    {isSelected && (
                      <Check
                        className="size-4 text-white drop-shadow-xs"
                        aria-hidden="true"
                      />
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Footer actions */}
          <div className="flex items-center justify-between border-t border-border/60 pt-4">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setName(identity.name);
                setTagline(identity.tagline);
                setBodyShape(identity.traits.bodyShape);
                setEyeStyle(identity.traits.eyeStyle);
                setColor(resolveColorId(identity.traits.color));
                setCustomImageUrl(identity.customImageUrl);
                setValidationError(null);
              }}
              className="gap-1.5 rounded-full text-xs text-muted-foreground"
            >
              <RotateCcw className="size-3.5" aria-hidden="true" />
              Reset
            </Button>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onOpenChange(false)}
                className="rounded-full px-4"
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={saving}
                onClick={handleSave}
                data-testid="agent-customizer-save"
                aria-label="Save agent identity"
                className="gap-1.5 rounded-full px-5 font-medium text-white shadow-sm"
                style={{ backgroundColor: activeHex }}
              >
                <Sparkles className="size-3.5" aria-hidden="true" />
                {saving ? "Saving…" : "Save Identity"}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
