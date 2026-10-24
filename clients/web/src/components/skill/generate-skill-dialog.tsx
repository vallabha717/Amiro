"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { experimental_useObject } from "@ai-sdk/react";
import { ChatModel } from "app-types/chat";
import { SkillGenerateSchema } from "app-types/skill";
import { handleErrorWithToast } from "ui/shared-toast";
import { CommandIcon, CornerRightUpIcon } from "lucide-react";
import { Dialog, DialogContent } from "ui/dialog";
import { PopupShell } from "ui/popup-shell";
import { Button } from "ui/button";
import { Textarea } from "ui/textarea";
import { MessageLoading } from "ui/message-loading";
import { SelectModel } from "@/components/select-model";
import { appStore } from "@/app/store";
import { backendFetch } from "@/lib/backend/client";
import { backendUrl } from "@/lib/backend/config";

interface GenerateSkillDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSkillChange: (data: { name?: string; description?: string; body?: string }) => void;
}

// The model drafts; the user saves -- nothing this dialog produces reaches
// disk except through POST /api/skills and its validator, which is why
// there is no onFinish call into createSkill here at all.
export function GenerateSkillDialog({
  open,
  onOpenChange,
  onSkillChange,
}: GenerateSkillDialogProps) {
  const t = useTranslations();
  const [generateModel, setGenerateModel] = useState<ChatModel | undefined>(
    appStore.getState().chatModel,
  );
  const [generateSkillPrompt, setGenerateSkillPrompt] = useState("");
  const [submittedPrompt, setSubmittedPrompt] = useState("");

  const { submit, isLoading, object } = experimental_useObject({
    api: backendUrl("/api/skills/generate"),
    fetch: backendFetch,
    schema: SkillGenerateSchema,
    onFinish(event) {
      if (event.error) {
        handleErrorWithToast(event.error);
      }
      if (event.object) {
        onSkillChange(event.object);
      }
      onOpenChange(false);
      setGenerateSkillPrompt("");
      setSubmittedPrompt("");
      setGenerateModel(appStore.getState().chatModel);
    },
  });

  const submitGenerateSkill = () => {
    setSubmittedPrompt(generateSkillPrompt);
    submit({
      message: generateSkillPrompt,
      chatModel: generateModel,
    });
    setGenerateSkillPrompt("");
  };

  useEffect(() => {
    if (object && isLoading) {
      onSkillChange(object);
    }
  }, [object, isLoading, onSkillChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] w-full max-w-full flex-col overflow-hidden p-0 xl:max-w-[40vw]">
        <PopupShell
          title={t("Skill.generateSkill")}
          description={t("Skill.generateSkill")}
        >
          <div className="flex flex-col gap-6 w-full">
          <div className="px-4">
            <p className="bg-secondary rounded-lg max-w-2/3 p-4">
              {t("Skill.generateSkillDetailedGreeting")}
            </p>
          </div>

          <div className="flex justify-end px-4">
            <p className="text-sm bg-primary text-primary-foreground py-4 px-6 rounded-lg">
              {isLoading && submittedPrompt ? (
                submittedPrompt
              ) : (
                <MessageLoading className="size-4" />
              )}
            </p>
          </div>

          <div className="relative flex flex-col border rounded-lg p-4">
            <Textarea
              value={generateSkillPrompt}
              autoFocus
              placeholder={t("Skill.inputPromptHere")}
              disabled={isLoading}
              onChange={(e) => setGenerateSkillPrompt(e.target.value)}
              data-testid="skill-generate-prompt-textarea"
              onKeyDown={(e) => {
                if (e.key === "Enter" && e.metaKey && !isLoading) {
                  e.preventDefault();
                  submitGenerateSkill();
                }
              }}
              className="w-full break-all pb-6 border-none! ring-0! resize-none min-h-24 max-h-48 overflow-y-auto placeholder:text-xs transition-colors"
            />
            <div className="flex justify-end items-center gap-2">
              <SelectModel
                showProvider
                onSelect={(model) => setGenerateModel(model)}
              />
              <Button
                disabled={!generateSkillPrompt.trim() || isLoading}
                size="sm"
                data-testid="skill-generate-submit-button"
                onClick={submitGenerateSkill}
                className="text-xs"
              >
                <span className="mr-1">
                  {isLoading ? t("Common.generating") : t("Common.send")}
                </span>
                {isLoading ? (
                  <div className="size-3 border border-current border-t-transparent rounded-full animate-spin" />
                ) : (
                  <>
                    <CommandIcon className="size-3" />
                    <CornerRightUpIcon className="size-3" />
                  </>
                )}
              </Button>
            </div>
          </div>
          </div>
        </PopupShell>
      </DialogContent>
    </Dialog>
  );
}
