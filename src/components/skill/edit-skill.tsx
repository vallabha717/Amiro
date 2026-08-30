"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useSWRConfig } from "swr";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { safe } from "ts-safe";
import { handleErrorWithToast } from "ui/shared-toast";
import { Loader, WandSparklesIcon } from "lucide-react";
import { Button } from "ui/button";
import { Input } from "ui/input";
import { Label } from "ui/label";
import { Textarea } from "ui/textarea";
import { ScrollArea } from "ui/scroll-area";
import { TextShimmer } from "ui/text-shimmer";
import { Badge } from "ui/badge";
import { cn } from "lib/utils";
import { notify } from "lib/notify";
import { appStore } from "@/app/store";
import { useObjectState } from "@/hooks/use-object-state";
import { useMutateSkills } from "@/hooks/queries/use-skills";
import {
  createSkill,
  deleteSkill,
  duplicateSkill,
  updateSkill,
} from "@/lib/backend/skills-api";
import {
  SKILL_DESCRIPTION_MAX_LENGTH,
  validateSkillDescription,
  validateSkillName,
  type Skill,
} from "@/types/skill";
import { ApiError } from "@/lib/backend/client";
import { GenerateSkillDialog } from "./generate-skill-dialog";

interface SkillDraft {
  name: string;
  description: string;
  body: string;
}

const emptyDraft: SkillDraft = { name: "", description: "", body: "" };

interface EditSkillProps {
  initialSkill?: Skill;
}

export default function EditSkill({ initialSkill }: EditSkillProps) {
  const t = useTranslations();
  const router = useRouter();
  const mutateSkills = useMutateSkills();
  const { mutate } = useSWRConfig();
  const projectDirectory = appStore((state) => state.projectDirectory);

  const isReadOnly = Boolean(initialSkill && !initialSkill.writable);
  const isNew = !initialSkill;

  const [skill, setSkill] = useObjectState<SkillDraft>(
    initialSkill
      ? {
          name: initialSkill.name,
          description: initialSkill.description,
          body: initialSkill.body,
        }
      : emptyDraft,
  );
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [isDuplicating, setIsDuplicating] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [openGenerateDialog, setOpenGenerateDialog] = useState(false);

  const isLoading = isSaving || isDuplicating || isDeleting;
  const isGenerating = openGenerateDialog;

  const descriptionCount = skill.description.length;
  const bodyLineCount = skill.body ? skill.body.split("\n").length : 0;

  // Non-blocking portability hints, computed live from the draft so they
  // are visible while editing rather than only in a toast the redirect on
  // save would immediately carry the user past. Mirrors the *soft*
  // (warning, not error) checks in internal/skills/validate.go: a vendor
  // prefix in the name, and a body over the ~500-line guideline.
  const nameWarning = useMemo(() => {
    const lower = skill.name.toLowerCase();
    if (lower.includes("claude") || lower.includes("anthropic")) {
      return t("Skill.validation.nameVendorPrefix");
    }
    return null;
  }, [skill.name, t]);

  const bodyWarning = useMemo(() => {
    if (bodyLineCount > 500) {
      return t("Skill.validation.bodyTooManyLines");
    }
    return null;
  }, [bodyLineCount, t]);

  const applyServerFieldErrors = useCallback(
    (info: unknown) => {
      const payload = info as
        | { errors?: { field: string; message: string }[] }
        | undefined;
      if (payload?.errors?.length) {
        const next: Record<string, string> = {};
        for (const e of payload.errors) next[e.field] = e.message;
        setFieldErrors(next);
        return true;
      }
      return false;
    },
    [setFieldErrors],
  );

  const saveSkill = useCallback(() => {
    setFieldErrors({});
    const req = {
      name: skill.name,
      description: skill.description,
      body: skill.body,
    };

    if (initialSkill) {
      safe(() => setIsSaving(true))
        .map(() => updateSkill(initialSkill.name, req))
        .ifOk(({ skill: saved }) => {
          mutateSkills(saved);
          toast.success(t("Skill.updated"));
          router.push("/skills");
        })
        .ifFail((e) => {
          if (e instanceof ApiError && applyServerFieldErrors(e.info)) return;
          handleErrorWithToast(e);
        })
        .watch(() => setIsSaving(false));
    } else {
      safe(() => setIsSaving(true))
        .map(() => createSkill(req))
        .ifOk(({ skill: created }) => {
          mutateSkills(created);
          toast.success(t("Skill.created"));
          router.push("/skills");
        })
        .ifFail((e) => {
          if (e instanceof ApiError && applyServerFieldErrors(e.info)) return;
          handleErrorWithToast(e);
        })
        .watch(() => setIsSaving(false));
    }
  }, [skill, initialSkill, mutateSkills, router, t, applyServerFieldErrors]);

  const duplicate = useCallback(() => {
    if (!initialSkill) return;
    safe(() => setIsDuplicating(true))
      .map(() => duplicateSkill(initialSkill.name, projectDirectory))
      .ifOk(({ skill: created }) => {
        mutateSkills(created);
        // When the writable root has no name collision, Duplicate lands
        // under the *identical* name (service.go's Duplicate only appends
        // "-copy" on an actual collision) -- the URL then doesn't change,
        // so the item-detail SWR key doesn't either, and the page would
        // otherwise keep showing the stale read-only version straight out
        // of cache. Force that one key fresh explicitly.
        mutate(`/api/skills/items/${encodeURIComponent(created.name)}`, created, {
          revalidate: true,
        });
        toast.success(t("Skill.duplicated"));
        router.push(`/skill?name=${encodeURIComponent(created.name)}`);
      })
      .ifFail(handleErrorWithToast)
      .watch(() => setIsDuplicating(false));
  }, [initialSkill, projectDirectory, mutateSkills, mutate, router, t]);

  const deleteExisting = useCallback(async () => {
    if (!initialSkill) return;
    const ok = await notify.confirm({
      description: t("Skill.deleteConfirm"),
    });
    if (!ok) return;
    safe(() => setIsDeleting(true))
      .map(() => deleteSkill(initialSkill.name))
      .ifOk(() => {
        mutateSkills(undefined, initialSkill.name);
        toast.success(t("Skill.deleted"));
        router.push("/skills");
      })
      .ifFail((e) => {
        // Phase 4's ErrUnexpectedFiles (422) names the offending files --
        // surface that message rather than a generic failure toast.
        handleErrorWithToast(e);
      })
      .watch(() => setIsDeleting(false));
  }, [initialSkill, mutateSkills, router, t]);

  const handleGenerated = useCallback(
    (data: { name?: string; description?: string; body?: string }) => {
      const nameError = data.name ? validateSkillName(data.name) : null;
      const descriptionError = data.description
        ? validateSkillDescription(data.description)
        : null;
      setFieldErrors((prev) => ({
        ...prev,
        ...(nameError
          ? { name: t(`Skill.validation.${nameError}`) }
          : { name: "" }),
        ...(descriptionError
          ? { description: t(`Skill.validation.${descriptionError}`) }
          : { description: "" }),
      }));
      setSkill((prev) => ({
        name: data.name ?? prev.name,
        description: data.description ?? prev.description,
        body: data.body ?? prev.body,
      }));
    },
    [setSkill, t],
  );

  const readOnlyNotice = useMemo(() => {
    if (!isReadOnly || !initialSkill) return null;
    return t("Skill.readOnlyOwnedBy", { source: initialSkill.source });
  }, [isReadOnly, initialSkill, t]);

  return (
    <ScrollArea className="h-full w-full relative">
      <div className="w-full h-8 absolute bottom-0 left-0 bg-gradient-to-t from-background to-transparent z-20 pointer-events-none" />
      <div className="z-10 relative flex flex-col gap-4 px-8 pt-8 pb-14 max-w-3xl h-full mx-auto">
        <div className="sticky top-0 bg-background z-10 flex items-center justify-between pb-4 gap-2">
          <div className="w-full h-8 absolute top-[100%] left-0 bg-gradient-to-b from-background to-transparent z-20 pointer-events-none" />
          {isGenerating ? (
            <TextShimmer className="w-full text-2xl font-bold">
              {t("Skill.generatingSkill")}
            </TextShimmer>
          ) : (
            <p className="w-full text-2xl font-bold">{t("Skill.title")}</p>
          )}

          {isNew && (
            <Button
              variant="ghost"
              disabled={isLoading}
              onClick={() => setOpenGenerateDialog(true)}
              data-testid="skill-generate-with-ai-button"
            >
              <WandSparklesIcon className="size-3" />
              {t("Common.generateWithAI")}
            </Button>
          )}
        </div>

        {readOnlyNotice && (
          <div className="flex items-center justify-between gap-2 rounded-lg border bg-secondary/40 px-4 py-3 text-sm">
            <span data-testid="skill-readonly-notice">{readOnlyNotice}</span>
            <Button
              variant="outline"
              size="sm"
              disabled={isLoading}
              onClick={duplicate}
              data-testid="skill-duplicate-button"
            >
              {isDuplicating ? t("Common.saving") : t("Skill.duplicateToMySkills")}
            </Button>
          </div>
        )}

        <div className="flex flex-col gap-2">
          <Label htmlFor="skill-name">{t("Skill.nameLabel")}</Label>
          <Input
            value={skill.name}
            onChange={(e) => setSkill({ name: e.target.value })}
            autoFocus={isNew}
            disabled={isLoading || isReadOnly || !isNew}
            readOnly={isReadOnly || !isNew}
            className="hover:bg-input bg-secondary/40 transition-colors border-transparent border-none! focus-visible:bg-input! ring-0!"
            id="skill-name"
            data-testid="skill-name-input"
            placeholder={t("Skill.namePlaceholder")}
          />
          {fieldErrors.name && (
            <p className="text-xs text-destructive" data-testid="skill-name-error">
              {fieldErrors.name}
            </p>
          )}
          {!fieldErrors.name && nameWarning && (
            <p className="text-xs text-muted-foreground" data-testid="skill-name-warning">
              {nameWarning}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="skill-description">{t("Skill.descriptionLabel")}</Label>
            <span
              className={cn(
                "text-xs text-muted-foreground",
                descriptionCount > SKILL_DESCRIPTION_MAX_LENGTH &&
                  "text-destructive",
              )}
            >
              {descriptionCount}/{SKILL_DESCRIPTION_MAX_LENGTH}
            </span>
          </div>
          <Textarea
            id="skill-description"
            data-testid="skill-description-input"
            disabled={isLoading || isReadOnly}
            readOnly={isReadOnly}
            placeholder={t("Skill.descriptionPlaceholder")}
            className="hover:bg-input placeholder:text-xs bg-secondary/40 min-h-20 resize-none transition-colors border-transparent border-none! focus-visible:bg-input! ring-0!"
            value={skill.description}
            onChange={(e) => setSkill({ description: e.target.value })}
          />
          {fieldErrors.description && (
            <p
              className="text-xs text-destructive"
              data-testid="skill-description-error"
            >
              {fieldErrors.description}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="skill-body">{t("Skill.bodyLabel")}</Label>
            <span className="text-xs text-muted-foreground">
              {t("Skill.lineCount", { count: bodyLineCount })}
            </span>
          </div>
          <Textarea
            id="skill-body"
            data-testid="skill-body-textarea"
            disabled={isLoading || isReadOnly}
            readOnly={isReadOnly}
            placeholder={t("Skill.bodyPlaceholder")}
            className="p-4 font-mono text-sm hover:bg-input min-h-96 max-h-[32rem] overflow-y-auto resize-none placeholder:text-xs bg-secondary/40 transition-colors border-transparent border-none! focus-visible:bg-input! ring-0!"
            value={skill.body}
            onChange={(e) => setSkill({ body: e.target.value })}
          />
          {bodyWarning && (
            <p className="text-xs text-muted-foreground" data-testid="skill-body-warning">
              {bodyWarning}
            </p>
          )}
        </div>

        {initialSkill && (
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-[10px] uppercase font-mono">
              {initialSkill.source}
            </Badge>
            <Badge variant="outline" className="text-[10px] uppercase font-mono">
              {initialSkill.scope}
            </Badge>
          </div>
        )}

        {!isReadOnly && (
          <div className="flex justify-end gap-2">
            {initialSkill && (
              <Button
                className="mt-2 hover:text-destructive"
                variant="ghost"
                onClick={deleteExisting}
                disabled={isLoading}
                data-testid="skill-delete-button"
              >
                {isDeleting ? t("Common.deleting") : t("Common.delete")}
              </Button>
            )}

            <Button
              className={cn("mt-2", !initialSkill ? "ml-auto" : "")}
              onClick={saveSkill}
              disabled={isLoading}
              data-testid="skill-save-button"
            >
              {isSaving ? t("Common.saving") : t("Common.save")}
              {isSaving && <Loader className="size-4 animate-spin" />}
            </Button>
          </div>
        )}
      </div>

      <GenerateSkillDialog
        open={openGenerateDialog}
        onOpenChange={setOpenGenerateDialog}
        onSkillChange={handleGenerated}
      />
    </ScrollArea>
  );
}
