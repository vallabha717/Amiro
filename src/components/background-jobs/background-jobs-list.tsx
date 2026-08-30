"use client";

import { useBackgroundJobs } from "@/hooks/queries/use-background-jobs";
import {
  BACKGROUND_JOBS_KEY,
  BackgroundJob,
  createBackgroundJob,
} from "@/lib/backend/background-jobs-api";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { mutate } from "swr";
import { Badge } from "ui/badge";
import { Button } from "ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "ui/card";
import { Checkbox } from "ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "ui/select";
import { handleErrorWithToast } from "ui/shared-toast";
import { Textarea } from "ui/textarea";

/** A run needing the user's attention gets a distinct badge color. */
const NEEDS_ATTENTION: Record<string, boolean> = {
  suspended: true,
  failed: true,
  interrupted: true,
};

function statusVariant(status: string): "outline" | "destructive" {
  return NEEDS_ATTENTION[status] ? "destructive" : "outline";
}

function StartRunForm() {
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<"edit" | "auto">("auto");
  const [autoPr, setAutoPr] = useState(false);
  const [busy, setBusy] = useState(false);

  const handleStart = async () => {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      await createBackgroundJob({ prompt: trimmed, mode, autoPr });
      setPrompt("");
      setAutoPr(false);
      toast.success("Background run started");
      mutate(BACKGROUND_JOBS_KEY);
    } catch (err) {
      handleErrorWithToast(err as Error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card data-testid="background-job-start-card">
      <CardHeader>
        <CardTitle className="text-sm">Start a background run</CardTitle>
        <CardDescription>
          Runs unattended -- it never asks for anything except a push or a
          pull request, which always asks, in every mode. Plan and
          interactive modes are not available here: there is no one to ask.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Textarea
          placeholder="what should the agent do?"
          value={prompt}
          disabled={busy}
          data-testid="background-job-prompt-input"
          onChange={(e) => setPrompt(e.target.value)}
        />
        <div className="flex items-center gap-4">
          <Select
            value={mode}
            onValueChange={(v) => setMode(v as "edit" | "auto")}
          >
            <SelectTrigger
              className="w-32"
              data-testid="background-job-mode-select"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="edit">edit</SelectItem>
              <SelectItem value="auto">auto</SelectItem>
            </SelectContent>
          </Select>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <Checkbox
              checked={autoPr}
              disabled={busy}
              data-testid="background-job-autopr-checkbox"
              onCheckedChange={(v) => setAutoPr(v === true)}
            />
            summarize, push and open a pull request on a clean finish
          </label>
          <div className="flex-1" />
          <Button
            size="sm"
            disabled={busy || !prompt.trim()}
            data-testid="background-job-start-button"
            onClick={handleStart}
          >
            Start run
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function JobRow({ job }: { job: BackgroundJob }) {
  return (
    <Link href={`/?thread=${job.threadId}`} data-testid="background-job-row">
      <Card className="hover:bg-accent/30 transition-all duration-200 cursor-pointer">
        <CardHeader className="py-4">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0 flex-1">
              <p className="font-medium text-sm truncate mb-1">
                {job.prompt}
              </p>
              <p className="text-xs text-muted-foreground">
                {job.mode} · started {new Date(job.startedAt).toLocaleString()}
                {job.autoPr ? " · auto-pr" : ""}
              </p>
              {job.error ? (
                <p className="text-xs text-destructive mt-1 truncate">
                  {job.error}
                </p>
              ) : null}
            </div>
            <Badge
              variant={statusVariant(job.status)}
              data-testid="background-job-status-badge"
            >
              {job.status}
            </Badge>
          </div>
        </CardHeader>
      </Card>
    </Link>
  );
}

/**
 * The "Agent runs" panel (docs/coding-agent-parity/05-background-agent-runs.md):
 * list of the caller's own background jobs, a start-a-run form, and a
 * resume action for anything needing attention. Resume is a plain link
 * into the job's own thread -- a suspended job's pending approval is an
 * ordinary approval card there, resolved exactly the way an interactive
 * one is, never a second resolution UI.
 */
export function BackgroundJobsList() {
  const { data: jobs, isLoading } = useBackgroundJobs();

  return (
    <div
      className="container mx-auto p-6 max-w-4xl"
      data-testid="background-jobs-panel"
    >
      <h1 className="text-2xl font-bold mb-2">Agent runs</h1>
      <p className="text-muted-foreground text-sm mb-6">
        Started once, they keep working after you close this tab.
      </p>

      <div className="mb-6">
        <StartRunForm />
      </div>

      <div className="space-y-3">
        {isLoading ? null : !jobs || jobs.length === 0 ? (
          <Card
            className="bg-transparent border-none"
            data-testid="background-jobs-empty"
          >
            <CardContent className="flex items-center justify-center py-12">
              <p className="text-muted-foreground text-center">
                No background runs yet.
              </p>
            </CardContent>
          </Card>
        ) : (
          jobs
            .slice()
            .sort(
              (a, b) =>
                new Date(b.startedAt).getTime() -
                new Date(a.startedAt).getTime(),
            )
            .map((job) => <JobRow key={job.id} job={job} />)
        )}
      </div>
    </div>
  );
}
