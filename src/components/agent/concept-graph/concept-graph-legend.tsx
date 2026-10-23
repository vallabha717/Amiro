import type { CSSProperties } from "react";
import {
  EDGE_LEARNED_COLOR,
  EDGE_LINK_COLOR,
  NODE_KIND_COLORS,
  nodeKindLabel,
} from "./constants";
import type { ConceptNodeKind } from "./types";

/** Cap the theme list so a big graph's legend stays compact. */
const MAX_THEMES = 8;

interface ConceptGraphLegendProps {
  /** Node kinds actually present in the graph, in display order. */
  nodeKinds: ConceptNodeKind[];
  /** When true (concept-only graph), nodes are colored by cluster/theme, so a
   * lone kind swatch would be meaningless — show the theme list instead. */
  coloredByTheme?: boolean;
  /** Named themes (hub concept + cluster color), largest first. When present
   * with `coloredByTheme`, the legend lists them so color maps to a theme. */
  themes?: readonly {
    color: string;
    name: string;
    concepts?: readonly string[];
  }[];
  hasLinks: boolean;
  hasLearned: boolean;
  onToggleLink?: () => void;
  onToggleLearned?: () => void;
  linkActive?: boolean;
  learnedActive?: boolean;
}

/** Compact legend for node kinds and edge kinds present in the graph. */
export function ConceptGraphLegend({
  nodeKinds,
  coloredByTheme,
  themes,
  hasLinks,
  hasLearned,
  onToggleLink,
  onToggleLearned,
  linkActive,
  learnedActive,
}: ConceptGraphLegendProps) {
  return (
    <div
      data-graph-control
      className="pointer-events-none absolute bottom-4 left-4 flex flex-col gap-1.5 rounded-lg border border-border/70 bg-card/85 px-3 py-2 backdrop-blur-md"
    >
      {nodeKinds.map((kind) => (
        <div key={kind} className="flex items-center gap-2">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: NODE_KIND_COLORS[kind] }}
          />
          <span className="text-[11px] text-muted-foreground">
            {nodeKindLabel(kind)}
          </span>
        </div>
      ))}
      {coloredByTheme &&
        (themes && themes.length > 0 ? (
          <>
            {themes.slice(0, MAX_THEMES).map((theme, i) => (
              <div key={i} className="flex items-center gap-2">
                <span
                  className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: theme.color }}
                />
                <span
                  className="max-w-[11rem] truncate text-[11px] text-muted-foreground"
                  title={theme.concepts?.join(" · ") ?? theme.name}
                >
                  {theme.name}
                </span>
              </div>
            ))}
            {themes.length > MAX_THEMES && (
              <span className="text-[11px] text-muted-foreground">
                +{themes.length - MAX_THEMES} more
              </span>
            )}
          </>
        ) : (
          <span className="text-[11px] text-muted-foreground">
            Colored by theme
          </span>
        ))}
      {(nodeKinds.length > 0 || coloredByTheme) && (hasLinks || hasLearned) && (
        <div className="mt-0.5 border-t border-border/60 pt-1.5" />
      )}
      {hasLinks && (
        <EdgeLegendRow
          swatchStyle={{ borderTop: `2px solid ${EDGE_LINK_COLOR}` }}
          label="Link"
          onToggle={onToggleLink}
          active={linkActive}
        />
      )}
      {hasLearned && (
        <EdgeLegendRow
          swatchStyle={{ borderTop: `2px dashed ${EDGE_LEARNED_COLOR}` }}
          label="Learned"
          onToggle={onToggleLearned}
          active={learnedActive}
        />
      )}
    </div>
  );
}

function EdgeLegendRow({
  swatchStyle,
  label,
  onToggle,
  active,
}: {
  swatchStyle: CSSProperties;
  label: string;
  onToggle?: () => void;
  active?: boolean;
}) {
  const swatch = <span className="inline-block h-0 w-4" style={swatchStyle} />;
  const text = (
    <span className="text-[11px] text-muted-foreground">{label}</span>
  );
  if (!onToggle) {
    return (
      <div className="flex items-center gap-2">
        {swatch}
        {text}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      className="pointer-events-auto flex cursor-pointer items-center gap-2 border-0 bg-transparent p-0 transition-opacity"
      style={{ opacity: active === false ? 0.4 : 1 }}
    >
      {swatch}
      {text}
    </button>
  );
}
