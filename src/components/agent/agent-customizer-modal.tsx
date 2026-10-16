"use client";

import {
  type AgentIdentity,
  updateAgentIdentity,
  useInvalidateAgentIdentity,
} from "@/hooks/queries/use-agent-identity";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { useThemeStyle } from "@/hooks/use-theme-style";
import type { CharacterTraits } from "@/lib/agent/character-catalog";
import { AGENT_ACCENT } from "@/lib/agent/theme-colors";
import { motion } from "framer-motion";
import { BASE_THEMES } from "lib/const";
import { capitalizeFirstLetter, cn } from "lib/utils";
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
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
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

/** Four plush variants — descriptive labels avoid color/tint confusion. */
const FORM_OPTIONS: Array<{ id: string; label: string; desc: string }> = [
  { id: "blob", label: "Headphones", desc: "Your listening companion" },
  { id: "sprout", label: "Sprout", desc: "A bright little sprout" },
  { id: "star", label: "Sunbeam", desc: "Always up for adventure" },
  { id: "cloud", label: "Dreamer", desc: "A cozy little star" },
];

const BODY_LABELS: Record<string, string> = {
  blob: "Headphones",
  sprout: "Sprout",
  star: "Sunbeam",
  cloud: "Dreamer",
  ghost: "Headphones",
  urchin: "Headphones",
};

const ALLOWED_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"];

function resolveColorId(colorId: string): string {
  return colorId === "blue" ? "cobalt" : colorId;
}

function normalizeBodyShape(id: string): string {
  if (id === "ghost") return "blob";
  if (id === "urchin") return "blob";
  if (FORM_OPTIONS.some((o) => o.id === id)) return id;
  return "blob";
}

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const defaultThemeStyle = {
  "--sidebar-primary": "var(--agent-default-primary)",
} as CSSProperties;

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
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const { themeStyle, setThemeStyle } = useThemeStyle();

  const [name, setName] = useState(identity.name);
  const [tagline, setTagline] = useState(identity.tagline);
  const [bodyShape, setBodyShape] = useState(() =>
    normalizeBodyShape(identity.traits.bodyShape),
  );
  // Eye style is fixed on plush PNGs — keep stored value for API compat, no UI.
  const eyeStyle = identity.traits.eyeStyle;
  const legacyColor = resolveColorId(identity.traits.color);
  const [customImageUrl, setCustomImageUrl] = useState<string | null>(
    identity.customImageUrl,
  );
  const [themeDraft, setThemeDraft] = useState(themeStyle);
  const [saving, setSaving] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(identity.name);
      setTagline(identity.tagline);
      setBodyShape(normalizeBodyShape(identity.traits.bodyShape));
      setCustomImageUrl(identity.customImageUrl);
      setThemeDraft(themeStyle);
      setValidationError(null);
    }
  }, [open, identity, themeStyle]);

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
      FORM_OPTIONS[Math.floor(Math.random() * FORM_OPTIONS.length)]?.id ??
      bodyShape;
    const t =
      BASE_THEMES[Math.floor(Math.random() * BASE_THEMES.length)] ?? themeDraft;
    setCustomImageUrl(null);
    setBodyShape(b);
    setThemeDraft(t);
  }, [bodyShape, themeDraft]);

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
        color: legacyColor,
      };
      await updateAgentIdentity({
        name: trimmedName,
        tagline:
          tagline.trim() || "Your Personal Intelligence powered by Jcode",
        traits,
        customImageUrl,
      });
      await invalidate();
      setThemeStyle(themeDraft);
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

  const handleCancel = useCallback(() => {
    // Discard draft theme — cancel preserves the committed theme.
    setThemeDraft(themeStyle);
    onOpenChange(false);
  }, [onOpenChange, themeStyle]);

  // Keep preview body label stable for legacy ids
  const previewLabel = BODY_LABELS[bodyShape] ?? bodyShape;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) handleCancel();
        else onOpenChange(next);
      }}
    >
      <DialogContent
        data-testid="agent-customizer-modal"
        data-theme={themeDraft}
        style={{
          ...(themeDraft === "default" ? defaultThemeStyle : {}),
          fontFamily:
            "var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif",
        }}
        className="max-w-xl max-h-[85vh] overflow-y-auto rounded-3xl border border-border/70 bg-background/95 p-0 shadow-2xl backdrop-blur-2xl"
      >
        {/* Preview stage — wrapped in data-theme={themeDraft} so var(--sidebar-primary) resolves to draft */}
        <div>
          <div
            className="relative flex flex-col items-center justify-center overflow-hidden px-6 pt-8 pb-6 transition-colors duration-300"
            style={{
              background: `radial-gradient(120% 95% at 50% 0%, color-mix(in srgb, ${AGENT_ACCENT} 28%, transparent) 0%, transparent 78%)`,
            }}
          >
            <DialogHeader className="z-10 mb-3 text-center">
              <DialogTitle className="font-brand text-2xl font-semibold tracking-tight">
                Customize Your Agent
              </DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground">
                Shape their look, sidebar-synced tint, and name
              </DialogDescription>
            </DialogHeader>

            <motion.div
              key={`${bodyShape}-${Boolean(customImageUrl)}-${themeDraft}`}
              initial={reduceMotion ? false : { scale: 0.92, opacity: 0.6 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: "spring", stiffness: 260, damping: 20 }}
              className="relative my-2 flex items-center justify-center"
              role="img"
              aria-label={`Preview of ${name || "Agent"} with ${previewLabel} form and ${themeDraft} theme`}
            >
              <div
                className="pointer-events-none absolute -inset-6 rounded-full opacity-35 blur-2xl transition-colors duration-300"
                style={{ backgroundColor: AGENT_ACCENT }}
              />
              {/* accentColor defaults to var(--sidebar-primary); draft var resolves via data-theme wrapper */}
              <AgentCharacterAvatar
                traits={{ bodyShape, eyeStyle, color: legacyColor }}
                customImageUrl={customImageUrl}
                size={148}
                interactive
                accentColor={AGENT_ACCENT}
              />
            </motion.div>

            <div className="z-10 mt-3 flex flex-wrap items-center justify-center gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={handleRandomize}
                data-testid="agent-customizer-randomize"
                aria-label="Surprise me with random form and theme"
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
        </div>

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

        <div className="flex flex-col gap-5 px-6 pt-4 pb-6">
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

          {/* Single Form cycler — four plush variants */}
          <div className="flex items-center justify-between rounded-2xl border border-border/60 bg-muted/30 px-3.5 py-2.5">
            <div className="min-w-0">
              <p className="text-[11px] font-medium text-muted-foreground">
                Form
              </p>
              <p className="truncate text-sm font-semibold capitalize">
                {previewLabel}
              </p>
              <p className="truncate text-[11px] text-muted-foreground">
                {FORM_OPTIONS.find((o) => o.id === bodyShape)?.desc ?? ""}
              </p>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-label="Previous form"
                onClick={() => {
                  setCustomImageUrl(null);
                  setBodyShape(cycleTrait(FORM_OPTIONS, bodyShape, -1));
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
                  setBodyShape(cycleTrait(FORM_OPTIONS, bodyShape, 1));
                }}
                className="flex size-7 items-center justify-center rounded-full border border-border/60 bg-background/80 text-foreground transition-transform hover:bg-accent active:scale-95 focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ChevronRight className="size-4" aria-hidden="true" />
              </button>
            </div>
          </div>

          {/* Theme picker — 19 sidebar themes, same names as sidebar */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">
                Theme · Sidebar & Agent tint
              </span>
              <span className="font-mono text-[11px] text-muted-foreground">
                {capitalizeFirstLetter(themeDraft)}
              </span>
            </div>
            <div
              role="group"
              aria-label="Select theme for sidebar and agent"
              className="grid max-h-48 grid-cols-2 gap-2 overflow-y-auto pr-1 sm:grid-cols-3"
            >
              {BASE_THEMES.map((t) => {
                const selected = themeDraft === t;
                return (
                  <button
                    key={t}
                    type="button"
                    aria-pressed={selected}
                    aria-label={`Select ${t} theme`}
                    data-testid={`agent-theme-${t}`}
                    data-theme={t}
                    style={t === "default" ? defaultThemeStyle : undefined}
                    onClick={() => setThemeDraft(t)}
                    className={cn(
                      "relative flex h-9 items-center justify-center rounded-xl border px-2 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                      selected
                        ? "border-foreground bg-foreground text-background"
                        : "border-border/60 bg-muted/30 text-foreground hover:bg-accent",
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className="mr-1.5 size-3 shrink-0 rounded-full border border-border"
                      style={{ backgroundColor: AGENT_ACCENT }}
                    />
                    {selected && (
                      <Check
                        className="mr-1 size-3.5 shrink-0"
                        aria-hidden="true"
                      />
                    )}
                    <span className="truncate">{capitalizeFirstLetter(t)}</span>
                  </button>
                );
              })}
            </div>
            <p className="text-[11px] text-muted-foreground">
              Save Identity applies this theme to your Agent and sidebar. Cancel
              keeps your current theme.
            </p>
          </div>

          <div className="flex items-center justify-between border-t border-border/60 pt-4">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setName(identity.name);
                setTagline(identity.tagline);
                setBodyShape(normalizeBodyShape(identity.traits.bodyShape));
                setCustomImageUrl(identity.customImageUrl);
                setThemeDraft(themeStyle);
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
                onClick={handleCancel}
                data-testid="agent-customizer-cancel"
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
                className="gap-1.5 rounded-full px-5 font-medium text-primary-foreground shadow-sm"
                style={{ backgroundColor: AGENT_ACCENT }}
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
