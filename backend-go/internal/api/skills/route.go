package skills

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"

	"amiro/backend/internal/api/httpjson"
	"amiro/backend/internal/auth"
	"amiro/backend/internal/skills"
)

func resolveProjectParam(project string) (string, error) {
	if project == "" {
		return "", nil
	}
	if !filepath.IsAbs(project) {
		return "", errors.New("project must be an absolute path")
	}
	clean := filepath.Clean(project)
	realPath, err := filepath.EvalSymlinks(clean)
	if err != nil {
		return "", errors.New("project path does not exist")
	}
	fi, err := os.Stat(realPath)
	if err != nil || !fi.IsDir() {
		return "", errors.New("project path is not a directory")
	}
	return realPath, nil
}

// List handles GET /api/skills.
// Optional query param: ?project=<abs_path>
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	_, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpjson.Unauthorized(w)
		return
	}

	projectParam := r.URL.Query().Get("project")
	project, err := resolveProjectParam(projectParam)
	if err != nil {
		httpjson.BadRequest(w, err.Error())
		return
	}

	home, _ := os.UserHomeDir()
	res, err := h.service.List(r.Context(), home, project)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}

	httpjson.OK(w, toListResponse(res))
}

// Get handles GET /api/skills/items/{name}.
// Optional query param: ?project=<abs_path>
func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	_, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpjson.Unauthorized(w)
		return
	}

	name := r.PathValue("name")
	if name == "" {
		httpjson.BadRequest(w, "skill name is required")
		return
	}

	projectParam := r.URL.Query().Get("project")
	project, err := resolveProjectParam(projectParam)
	if err != nil {
		httpjson.BadRequest(w, err.Error())
		return
	}

	home, _ := os.UserHomeDir()
	skill, err := h.service.Get(r.Context(), home, project, name)
	if err != nil {
		if errors.Is(err, skills.ErrSkillNotFound) {
			httpjson.NotFound(w, "skill not found")
			return
		}
		httpjson.ServerError(w, err)
		return
	}

	httpjson.OK(w, toSkillDTO(skill))
}
