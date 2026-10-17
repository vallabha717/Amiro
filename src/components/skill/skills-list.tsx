"use client";
import { useAgentTheme } from "@/hooks/use-agent-theme";

import { appStore } from "@/app/store";
import { useAgentIdentity } from "@/hooks/queries/use-agent-identity";
import { useMutateSkills, useSkills } from "@/hooks/queries/use-skills";
import { duplicateSkill } from "@/lib/backend/skills-api";
import type { SkillSummary } from "@/types/skill";
import type { ChatMention } from "app-types/chat";
import { useReducedMotion } from "framer-motion";
import { cn } from "lib/utils";
import {
  ArrowLeft,
  ArrowUpRight,
  Copy,
  LayoutGrid,
  Lock,
  Orbit,
  Plus,
  Search,
  Sparkles,
  Zap,
} from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { BackgroundPaths } from "ui/background-paths";
import { Badge } from "ui/badge";
import { Button } from "ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "ui/card";
import { Input } from "ui/input";

type SuperpowerFilter = "all" | "builtin" | "custom" | "project";
type SuperpowerViewMode = "split" | "constellation" | "grid";

const SOURCE_META: Record<
  string,
  { label: string; color: string; bg: string }
> = {
  ".amiro": {
    label: "Built-in Skill",
    color: "#E9642F",
    bg: "rgba(233, 100, 47, 0.14)",
  },
  ".agents": {
    label: "Project Agent",
    color: "#0E9B8B",
    bg: "rgba(14, 155, 139, 0.14)",
  },
  ".codex": {
    label: "Codex Skill",
    color: "#A665C9",
    bg: "rgba(166, 101, 201, 0.14)",
  },
};

function isEngineOwnedSource(source: string): boolean {
  return source === ".amiro";
}

function SuperpowersConstellation({
  skills,
  selectedName,
  onSelectSkill,
  accentHex,
  agentName,
}: {
  skills: SkillSummary[];
  selectedName: string | null;
  onSelectSkill: (skill: SkillSummary) => void;
  accentHex: string;
  agentName: string;
}) {
  const reduceMotion = useReducedMotion();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hoveredName, setHoveredName] = useState<string | null>(null);
  const rotationRef = useRef(0);

  // Compute radial orbit positions grouped by source
  const nodes = useMemo(() => {
    return skills.map((s, idx) => {
      const ring = s.writable ? 1 : isEngineOwnedSource(s.source) ? 1.45 : 1.9;
      const angle = (idx / Math.max(1, skills.length)) * Math.PI * 2;
      const meta = SOURCE_META[s.source] ?? {
        label: s.source,
        color: accentHex,
        bg: "rgba(233, 100, 47, 0.14)",
      };
      return {
        skill: s,
        ring,
        baseAngle: angle,
        color: meta.color,
        radius: s.writable ? 14 : 12,
      };
    });
  }, [skills, accentHex]);

  const screenNodesRef = useRef<
    Array<{ skill: SkillSummary; x: number; y: number; r: number }>
  >([]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let raf = 0;

    const render = () => {
      cancelAnimationFrame(raf);
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      if (
        canvas.width !== Math.round(rect.width * dpr) ||
        canvas.height !== Math.round(rect.height * dpr)
      ) {
        canvas.width = Math.round(rect.width * dpr);
        canvas.height = Math.round(rect.height * dpr);
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, rect.width, rect.height);

      const cx = rect.width / 2;
      const cy = rect.height / 2;
      const baseOrbit = Math.min(rect.width, rect.height) * 0.21;

      if (!reduceMotion) rotationRef.current += 0.0018;
      const rot = rotationRef.current;

      // Subtle concentric orbital rings
      for (const mult of [1, 1.45, 1.9]) {
        ctx.beginPath();
        ctx.arc(cx, cy, baseOrbit * mult, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(140, 148, 160, 0.16)";
        ctx.setLineDash([3, 6]);
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.setLineDash([]);

      const projected: Array<{
        skill: SkillSummary;
        x: number;
        y: number;
        r: number;
        color: string;
      }> = [];

      for (const n of nodes) {
        const a = n.baseAngle + rot * (n.ring === 1 ? 1 : 0.65);
        const dist = baseOrbit * n.ring;
        const x = cx + Math.cos(a) * dist;
        const y = cy + Math.sin(a) * dist * 0.82;

        // Spoke from center agent to superpower node
        const isActive =
          selectedName === n.skill.name || hoveredName === n.skill.name;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(x, y);
        ctx.strokeStyle = isActive ? n.color : "rgba(140, 148, 160, 0.22)";
        ctx.lineWidth = isActive ? 1.8 : 1;
        ctx.stroke();

        projected.push({
          skill: n.skill,
          x,
          y,
          r: isActive ? n.radius + 3 : n.radius,
          color: n.color,
        });
      }

      // Center core representing the Agent
      const grad = ctx.createRadialGradient(cx, cy, 4, cx, cy, 38);
      grad.addColorStop(0, accentHex);
      grad.addColorStop(1, "rgba(233, 100, 47, 0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, 38, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = accentHex;
      ctx.beginPath();
      ctx.arc(cx, cy, 18, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "#FDFDFC";
      ctx.font = "600 11px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(agentName.slice(0, 6), cx, cy);

      // Draw each skill node + label
      for (const p of projected) {
        const isActive =
          selectedName === p.skill.name || hoveredName === p.skill.name;
        if (isActive) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r + 6, 0, Math.PI * 2);
          ctx.fillStyle = `${p.color}33`;
          ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = p.color;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = "rgba(255,255,255,0.85)";
        ctx.stroke();

        ctx.font = isActive
          ? "600 12px system-ui, sans-serif"
          : "500 11px system-ui, sans-serif";
        ctx.fillStyle = isActive ? p.color : "rgba(140, 148, 160, 0.92)";
        ctx.textAlign = "center";
        ctx.fillText(`/${p.skill.name}`, p.x, p.y + p.r + 13);
      }

      screenNodesRef.current = projected;
      ctx.restore();
      if (!reduceMotion) raf = requestAnimationFrame(render);
    };

    const observer = new ResizeObserver(render);
    observer.observe(canvas);
    raf = requestAnimationFrame(render);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [nodes, selectedName, hoveredName, accentHex, agentName, reduceMotion]);

  const findHit = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    for (const p of screenNodesRef.current) {
      const dx = x - p.x;
      const dy = y - p.y;
      if (dx * dx + dy * dy <= (p.r + 8) * (p.r + 8)) {
        return p.skill;
      }
    }
    return null;
  };

  return (
    <div className="relative flex h-[320px] w-full flex-col overflow-hidden rounded-3xl border border-border/60 bg-card/65 backdrop-blur-xl">
      <div className="pointer-events-none absolute top-4 left-5 z-10 flex items-center gap-2">
        <Orbit className="size-4 text-muted-foreground" aria-hidden="true" />
        <span className="text-xs font-medium text-muted-foreground">
          Superpowers Constellation · Select a skill to inspect
        </span>
      </div>
      <canvas
        ref={canvasRef}
        data-testid="superpowers-constellation-canvas"
        aria-hidden="true"
        onMouseMove={(e) => {
          const hit = findHit(e.clientX, e.clientY);
          setHoveredName(hit ? hit.name : null);
        }}
        onClick={(e) => {
          const hit = findHit(e.clientX, e.clientY);
          if (hit) onSelectSkill(hit);
        }}
        className="h-full w-full cursor-pointer"
      />
      <div className="sr-only focus-within:not-sr-only focus-within:absolute focus-within:inset-x-4 focus-within:bottom-3 focus-within:z-20 focus-within:flex focus-within:flex-wrap focus-within:gap-2 focus-within:rounded-lg focus-within:bg-background focus-within:p-2">
        {skills.map((skill) => (
          <button key={skill.name} onClick={() => onSelectSkill(skill)}>
            Inspect {skill.name}
          </button>
        ))}
      </div>
    </div>
  );
}

export function SkillsList() {
  const t = useTranslations();
  const router = useRouter();
  const projectDirectory = appStore((state) => state.projectDirectory);
  const { data, isLoading } = useSkills({ projectDirectory });
  const mutateSkills = useMutateSkills();
  const { data: identity } = useAgentIdentity();

  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SuperpowerFilter>("all");
  const [viewMode, setViewMode] = useState<SuperpowerViewMode>("split");
  const [selectedSkillName, setSelectedSkillName] = useState<string | null>(
    null,
  );
  const [duplicatingName, setDuplicatingName] = useState<string | null>(null);

  const items = data?.items ?? [];
  const { accentHex } = useAgentTheme();
  const agentName = identity?.name || "Amiro";

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((s) => {
      if (filter === "builtin" && !isEngineOwnedSource(s.source)) return false;
      if (filter === "custom" && !s.writable) return false;
      if (filter === "project" && s.scope !== "project") return false;
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        (s.description || "").toLowerCase().includes(q) ||
        s.source.toLowerCase().includes(q)
      );
    });
  }, [items, query, filter]);

  const mySkills = useMemo(
    () => filtered.filter((s) => s.writable),
    [filtered],
  );
  const discovered = useMemo(
    () => filtered.filter((s) => !s.writable),
    [filtered],
  );

  const handleUseInChat = useCallback(
    (skill: SkillSummary, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (skill.deliverable === false || skill.disableModelInvocation) return;
      const mention: ChatMention = {
        type: "skill",
        name: skill.name,
        description: skill.description,
      };
      const currentThreadId = appStore.getState().currentThreadId;
      if (currentThreadId) {
        appStore.setState((prev) => ({
          threadMentions: {
            ...prev.threadMentions,
            [currentThreadId]: [
              ...(prev.threadMentions[currentThreadId] || []).filter(
                (v) => !(v.type === "skill" && v.name === skill.name),
              ),
              mention,
            ],
          },
        }));
      } else {
        appStore.setState({ pendingThreadMention: mention });
      }
      router.push(
        currentThreadId
          ? `/?thread=${encodeURIComponent(currentThreadId)}`
          : "/",
      );
    },
    [router],
  );

  const handleDuplicate = useCallback(
    async (skill: SkillSummary, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDuplicatingName(skill.name);
      try {
        const res = await duplicateSkill(
          skill.name,
          projectDirectory ?? undefined,
        );
        mutateSkills(res.skill);
        toast.success(`Cloned /${skill.name} as /${res.skill.name}`);
        router.push(`/skill?name=${encodeURIComponent(res.skill.name)}`);
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Could not duplicate skill.",
        );
      } finally {
        setDuplicatingName(null);
      }
    },
    [projectDirectory, mutateSkills, router],
  );

  return (
    <div className="mx-auto flex w-full max-w-[1360px] flex-col gap-6 p-6 sm:p-8">
      {/* Top Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Link
            href="/agent"
            data-testid="superpowers-back-link"
            className="inline-flex h-9 items-center gap-1.5 rounded-full border border-border/60 bg-card/80 px-3.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" aria-hidden="true" />
            Agent Hub
          </Link>
          <div>
            <div className="flex items-center gap-2">
              <h1
                className="font-brand text-2xl font-bold tracking-tight sm:text-3xl"
                data-testid="skills-title"
              >
                Superpowers
              </h1>
              <Badge
                variant="secondary"
                className="rounded-full font-mono text-xs tabular-nums"
              >
                {items.length} total
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              Skills and capabilities powering {agentName} across Amiro and your
              workspace
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* View Mode Switcher */}
          <div className="inline-flex items-center rounded-full border border-border/60 bg-muted/40 p-0.5 text-xs">
            {(
              [
                ["split", "Constellation + Grid"],
                ["constellation", "Orbit"],
                ["grid", "Cards"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                aria-pressed={viewMode === id}
                onClick={() => setViewMode(id)}
                className={cn(
                  "cursor-pointer rounded-full px-3 py-1 font-medium transition-colors",
                  viewMode === id
                    ? "bg-background text-foreground shadow-2xs"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>

          <Link href="/skill?name=new">
            <Button
              variant="default"
              size="sm"
              className="gap-1.5 rounded-full px-4"
              data-testid="create-skill-button"
              style={{ backgroundColor: accentHex, color: "#FFFFFF" }}
            >
              <Plus className="size-4" aria-hidden="true" />
              {t("Skill.newSkill")}
            </Button>
          </Link>
        </div>
      </div>

      {/* Search & Source Filters */}
      <p className="text-xs leading-relaxed text-muted-foreground">
        Skills shape your agent’s instructions, not its permissions. Actions
        still depend on the tools enabled in Amiro.
      </p>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative min-w-[240px] flex-1 max-w-md">
          <Search
            className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search superpowers"
            placeholder="Search superpowers by name, source, or purpose…"
            data-testid="superpowers-search-input"
            className="h-9 rounded-full pl-9 text-xs"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {(
            [
              ["all", `All (${items.length})`],
              [
                "builtin",
                `Built-in (${items.filter((s) => isEngineOwnedSource(s.source)).length})`,
              ],
              [
                "custom",
                `My Custom (${items.filter((s) => s.writable).length})`,
              ],
              [
                "project",
                `Project (${items.filter((s) => s.scope === "project").length})`,
              ],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              data-testid={`superpowers-filter-${id}`}
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
              className={cn(
                "cursor-pointer rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                filter === id
                  ? "border-foreground bg-foreground text-background"
                  : "border-border/60 bg-card/70 text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Interactive Constellation Orbit */}
      {(viewMode === "split" || viewMode === "constellation") &&
        filtered.length > 0 && (
          <SuperpowersConstellation
            skills={filtered}
            selectedName={selectedSkillName}
            onSelectSkill={(s) => {
              setSelectedSkillName(s.name);
              router.push(`/skill?name=${encodeURIComponent(s.name)}`);
            }}
            accentHex={accentHex}
            agentName={agentName}
          />
        )}

      {/* Cards Grid */}
      {viewMode !== "constellation" && (
        <>
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2">
              <Zap className="size-4 text-primary" aria-hidden="true" />
              <h2 className="text-lg font-semibold">{t("Skill.mySkills")}</h2>
              <span className="text-xs text-muted-foreground tabular-nums">
                ({mySkills.length})
              </span>
              <div className="h-px flex-1 bg-border" />
            </div>

            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              <Link href="/skill?name=new">
                <Card
                  className="relative h-[204px] cursor-pointer overflow-hidden rounded-2xl bg-secondary transition-colors hover:bg-input"
                  data-testid="create-skill-card"
                >
                  <div className=" absolute inset-0 h-full w-full opacity-50">
                    <BackgroundPaths />
                  </div>
                  <CardHeader className="relative z-10 flex h-full flex-col justify-between">
                    <div>
                      <CardTitle>
                        <span className="text-lg font-bold">
                          {t("Skill.newSkill")}
                        </span>
                      </CardTitle>
                      <CardDescription className="mt-2">
                        {t("Layout.createYourOwnSkill")}
                      </CardDescription>
                    </div>
                    <div className="ml-auto">
                      <Button variant="ghost" size="sm" className="gap-1">
                        {t("Common.create")}
                        <ArrowUpRight className="size-3.5" />
                      </Button>
                    </div>
                  </CardHeader>
                </Card>
              </Link>

              {!isLoading &&
                mySkills.map((skill) => (
                  <SkillCard
                    key={skill.name}
                    skill={skill}
                    onUseInChat={handleUseInChat}
                    onDuplicate={handleDuplicate}
                    duplicating={duplicatingName === skill.name}
                  />
                ))}
            </div>
          </div>

          <div className="mt-4 flex flex-col gap-4">
            <div className="flex items-center gap-2">
              <LayoutGrid
                className="size-4 text-muted-foreground"
                aria-hidden="true"
              />
              <h2 className="text-lg font-semibold">
                Runtime & Workspace Superpowers
              </h2>
              <span className="text-xs text-muted-foreground tabular-nums">
                ({discovered.length})
              </span>
              <div className="h-px flex-1 bg-border" />
            </div>

            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {!isLoading &&
                discovered.map((skill) => (
                  <SkillCard
                    key={skill.name}
                    skill={skill}
                    onUseInChat={handleUseInChat}
                    onDuplicate={handleDuplicate}
                    duplicating={duplicatingName === skill.name}
                  />
                ))}

              {!isLoading && discovered.length === 0 && (
                <Card className="col-span-full border-none bg-transparent">
                  <CardHeader className="py-12 text-center">
                    <CardTitle>{t("Skill.noDiscoveredSkills")}</CardTitle>
                    <CardDescription>
                      {t("Skill.noDiscoveredSkillsDescription")}
                    </CardDescription>
                  </CardHeader>
                </Card>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function SkillCard({
  skill,
  onUseInChat,
  onDuplicate,
  duplicating,
}: {
  skill: SkillSummary;
  onUseInChat: (skill: SkillSummary, e: React.MouseEvent) => void;
  onDuplicate: (skill: SkillSummary, e: React.MouseEvent) => void;
  duplicating: boolean;
}) {
  const t = useTranslations();
  const meta = SOURCE_META[skill.source] ?? {
    label: skill.source,
    color: "#E9642F",
    bg: "rgba(233, 100, 47, 0.12)",
  };

  return (
    <div>
      <Card
        className={cn(
          "group @container flex min-h-[204px] w-full cursor-pointer flex-col justify-between gap-3 rounded-2xl border-border/60 transition-all hover:-translate-y-0.5 hover:bg-input/60 hover:shadow-md",
        )}
        data-testid="skill-card"
        data-item-name={skill.name}
      >
        <CardHeader className="flex h-full flex-col justify-between gap-y-2">
          <div>
            <CardTitle className="flex min-w-0 items-center gap-3">
              <div
                className="flex shrink-0 items-center justify-center rounded-xl p-2.5"
                style={{ backgroundColor: meta.bg, color: meta.color }}
              >
                <Sparkles className="size-4" aria-hidden="true" />
              </div>
              <div className="flex min-w-0 flex-1 flex-col">
                <Link
                  href={`/skill?name=${encodeURIComponent(skill.name)}`}
                  title={skill.name}
                  className="truncate font-mono text-sm font-semibold hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                >
                  /{skill.name}
                </Link>
                <span className="text-[11px] font-normal text-muted-foreground">
                  {meta.label}
                </span>
              </div>
              {!skill.writable && (
                <Lock
                  className="size-3.5 shrink-0 text-muted-foreground"
                  data-testid="skill-card-lock"
                  aria-label="Read-only skill"
                />
              )}
            </CardTitle>
            <CardDescription className="mt-2.5 line-clamp-2 text-xs leading-relaxed">
              {skill.description || t("Skill.noDescription")}
            </CardDescription>
          </div>

          <div className="mt-auto flex items-center justify-between gap-2 pt-3">
            <div className="flex items-center gap-1.5">
              <Badge
                variant="outline"
                data-testid={`skill-card-source-${skill.source}`}
                className="h-4 border-muted-foreground/30 px-1.5 py-0 font-mono text-[10px] uppercase text-muted-foreground"
              >
                {skill.source}
              </Badge>
              <Badge
                variant="outline"
                className="h-4 border-muted-foreground/30 px-1.5 py-0 font-mono text-[10px] uppercase text-muted-foreground"
              >
                {skill.scope}
              </Badge>
            </div>

            <div className="flex items-center gap-1 opacity-85 transition-opacity group-hover:opacity-100">
              {!skill.writable && (
                <button
                  type="button"
                  disabled={duplicating}
                  onClick={(e) => onDuplicate(skill, e)}
                  title="Duplicate into My Skills to customize"
                  className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-full border border-border/70 bg-background/80 px-2 text-[11px] font-medium text-muted-foreground hover:text-foreground"
                >
                  <Copy className="size-3" aria-hidden="true" />
                  {duplicating ? "Cloning…" : "Fork"}
                </button>
              )}
              <button
                type="button"
                disabled={
                  skill.deliverable === false || skill.disableModelInvocation
                }
                onClick={(e) => onUseInChat(skill, e)}
                title={
                  skill.deliverable === false
                    ? skill.invokableReason
                    : `Add /${skill.name} instructions to your next message`
                }
                className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-full border border-border/70 bg-background/80 px-2.5 text-[11px] font-medium text-foreground hover:bg-accent"
              >
                Add to message
              </button>
            </div>
          </div>
        </CardHeader>
      </Card>
    </div>
  );
}
