package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"amiro/backend/internal/agent/repomap"
	"amiro/backend/internal/agent/workspace"
)

// RepoMapOutput is the tool result. Both shapes of the same map:
// Text is what the model reads, Files is what the presenter renders.
//
// Carrying both looks redundant and is not. The model wants the cheapest
// token encoding of an outline; the UI wants something it can make a
// collapsible tree out of without parsing prose back into structure. Making
// either read the other's format costs one of them something real.
type RepoMapOutput struct {
	Text    string         `json:"text"`
	Files   []repomap.File `json:"files"`
	Scanned int            `json:"scanned"`
	Skipped int            `json:"skipped"`
	Focus   []string       `json:"focus,omitempty"`
	Partial bool           `json:"partial"`
	Root    string         `json:"root"`
}

type repoMapInput struct {
	Path   string   `json:"path"`
	Focus  []string `json:"focus"`
	Budget int      `json:"budget"`
}

// maxRepoMapFiles bounds what the *presenter* receives, not what was
// ranked. The rendered text is already budgeted; this stops a 4,000-file
// repo from putting 4,000 file objects into a persisted message part,
// where it would cost far more to store and reload than it could ever be
// worth on screen.
const maxRepoMapFiles = 200

func repoMapTool(ws *workspace.Workspace) Definition {
	return Definition{
		Name:    NameRepoMap,
		Toolkit: ToolkitFile,
		Risk:    RiskRead,
		Description: "Get a ranked outline of the repository: which files exist, what each declares, " +
			"ordered by how much the rest of the codebase depends on them. Use this FIRST on an " +
			"unfamiliar codebase, before globbing or grepping around -- it is one call instead of " +
			"a dozen. Pass `focus` with words from the task ('auth', 'permission', 'billing') to " +
			"rank the map toward that area rather than the repo as a whole. Declarations only: " +
			"read a file to see what its functions actually do.",
		ParametersSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"path": {"type": "string", "description": "Subdirectory to map, relative to the workspace root. Omit for the whole workspace."},
				"focus": {
					"type": "array",
					"items": {"type": "string"},
					"description": "Words to bias ranking toward -- topic names, symbol names, path fragments. Strongly recommended: an unfocused map of a large repo is dominated by whatever everything imports."
				},
				"budget": {"type": "integer", "description": "Approximate character budget for the rendered map. Default 16000. Raise only if the map came back truncated and you need the rest."}
			},
			"additionalProperties": false
		}`),
		Execute: func(ctx context.Context, raw json.RawMessage) (any, error) {
			var in repoMapInput
			if len(raw) > 0 {
				if err := json.Unmarshal(raw, &in); err != nil {
					return nil, fmt.Errorf("repo_map: %w", err)
				}
			}

			root := ws.Root()
			if p := strings.TrimSpace(in.Path); p != "" && p != "." {
				resolved, err := ws.ResolveReadable(p)
				if err != nil {
					return nil, err
				}
				root = resolved
			}

			// The same ignore rules list_dir uses, so the map and the
			// listing describe the same repository. A map that includes
			// build output the listing hides is a map of something the user
			// does not think they have.
			ignore := loadIgnore(ws.Root())

			m, err := repomap.Build(ctx, repomap.Options{
				Root:  root,
				Focus: in.Focus,
				Skip: func(rel string, isDir bool) bool {
					return ignore.match(rel, isDir)
				},
			})
			if err != nil {
				return nil, fmt.Errorf("repo_map: %w", err)
			}

			rel, relErr := ws.Rel(root)
			if relErr != nil || rel == "." {
				rel = ""
			}

			files := m.Files
			if len(files) > maxRepoMapFiles {
				files = files[:maxRepoMapFiles]
			}
			return RepoMapOutput{
				Text:    m.Render(in.Budget),
				Files:   files,
				Scanned: m.Scanned,
				Skipped: m.Skipped,
				Focus:   in.Focus,
				Partial: m.Partial,
				Root:    rel,
			}, nil
		},
	}
}
