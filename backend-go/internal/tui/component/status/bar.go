// Package status renders the one-line strip under the composer: model,
// permission mode, workspace, tokens, cost and elapsed time -- the plan's
// Part 3 describes it as "live", which for Phase 2 means elapsed ticks
// every second while a turn streams; tokens and cost only exist once a
// turn's Finish frame has reported usage, same as the desktop app (the
// AI SDK's usage object is a stream-final value there too, not a running
// counter).
package status

import (
	"fmt"
	"time"

	"amiro/backend/internal/pricing"
	"amiro/backend/internal/tui/session"
	"amiro/backend/internal/tui/theme"
)

// Info is everything Render needs, gathered by the caller (page.Chat) from
// session.State plus the two things State doesn't know about itself: the
// workspace root (a launch-time constant) and how long the current/last
// turn has been running (wall-clock, timed by the page).
type Info struct {
	Model         string
	Mode          string
	WorkspaceRoot string
	Usage         *session.Usage
	Elapsed       time.Duration
	Streaming     bool

	// Dashboard is the URL `amiro --serve` is serving the web dashboard
	// on -- empty in the ordinary case, where nothing is served. It sits
	// in the status bar because that is the only place a full-screen TUI
	// can put a launch-time fact and still have it readable ten minutes
	// later; stderr scrolls past before the alt-screen even opens.
	Dashboard string

	// Hint is the keymap reminder ("enter to send · ctrl+c to quit") --
	// the page decides its wording (it knows whether a turn is in flight),
	// this package just gives it a slot in the same eliding-under-width
	// logic as everything else, so a narrow terminal drops it before it
	// drops the elapsed clock rather than wrapping the line.
	Hint string
}

// Render draws one line, eliding fields (never the elapsed clock or the
// streaming indicator -- those are why a user glances here) when width is
// too narrow to fit everything.
func Render(width int, info Info) string {
	fields := []string{}

	if info.Mode != "" {
		fields = append(fields, info.Mode)
	}
	if info.WorkspaceRoot != "" {
		fields = append(fields, shortenPath(info.WorkspaceRoot, 32))
	}
	if info.Model != "" {
		fields = append(fields, info.Model)
	}
	if info.Dashboard != "" {
		fields = append(fields, info.Dashboard)
	}
	if info.Usage != nil {
		fields = append(fields, fmt.Sprintf("%d tok", info.Usage.TotalTokens))
		if cost, ok := estimateCost(info.Model, info.Usage); ok {
			fields = append(fields, formatCost(cost))
		}
	}
	fields = append(fields, formatElapsed(info.Elapsed))
	if info.Hint != "" {
		fields = append(fields, info.Hint)
	}

	raw := joinFields(fields)
	if runeWidth(raw) <= width || len(fields) <= 1 {
		return theme.Default.StatusBar.Render(raw)
	}

	// Too wide: drop the middle fields (mode, workspace, model) before the
	// ones a user is actually watching live (tokens, cost, elapsed).
	minimal := []string{formatElapsed(info.Elapsed)}
	if info.Usage != nil {
		minimal = append([]string{fmt.Sprintf("%d tok", info.Usage.TotalTokens)}, minimal...)
	}
	return theme.Default.StatusBar.Render(joinFields(minimal))
}

func joinFields(fields []string) string {
	out := ""
	for i, f := range fields {
		if i > 0 {
			out += "  ·  "
		}
		out += f
	}
	return out
}

// estimateCost looks up model in the pricing catalog. ok is false when the
// model isn't in it -- an unpriced model shows no cost field at all rather
// than a misleading "$0.00" (a real cost the catalog just doesn't know,
// not a free one).
func estimateCost(model string, usage *session.Usage) (float64, bool) {
	provider, name := splitModel(model)
	if name == "" {
		return 0, false
	}
	if _, _, found := pricing.DefaultCatalog().GetModelPrice(provider, name); !found {
		return 0, false
	}
	total, _, _ := pricing.DefaultCatalog().CalculateCost(provider, name, int64(usage.PromptTokens), int64(usage.CompletionTokens))
	return total, true
}

// splitModel reads session.State.Model's "provider/model" back apart --
// the one place that string gets built (reduce.go's applyFinishMetadata)
// and the one place it gets taken apart, so a change to the join format
// only ever needs updating here.
func splitModel(s string) (provider, model string) {
	for i := 0; i < len(s); i++ {
		if s[i] == '/' {
			return s[:i], s[i+1:]
		}
	}
	return "", s
}

func formatCost(usd float64) string {
	if usd < 0.01 {
		return fmt.Sprintf("$%.4f", usd)
	}
	return fmt.Sprintf("$%.2f", usd)
}

func formatElapsed(d time.Duration) string {
	if d < time.Minute {
		return fmt.Sprintf("%ds", int(d.Round(time.Second).Seconds()))
	}
	m := int(d.Minutes())
	s := int(d.Round(time.Second).Seconds()) % 60
	return fmt.Sprintf("%dm%02ds", m, s)
}

// shortenPath keeps a workspace path's tail, the informative end for
// telling two checkouts apart, when the whole thing doesn't fit.
func shortenPath(p string, max int) string {
	if len(p) <= max {
		return p
	}
	if max <= 1 {
		return "…"
	}
	return "…" + p[len(p)-(max-1):]
}

// runeWidth is a plain rune count, not a display-width library -- status
// bar fields are ASCII by construction (numbers, "tok", "$", a workspace
// path), so this is exact for what this package ever renders. Callers must
// measure the unstyled string: lipgloss.Style.Render's ANSI escape codes
// would otherwise get counted as display width, overestimating it and
// eliding fields a real terminal had room for.
func runeWidth(s string) int {
	return len([]rune(s))
}
