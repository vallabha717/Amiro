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

// Create handles POST /api/skills.
func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	_, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpjson.Unauthorized(w)
		return
	}

	var req WriteRequest
	if !httpjson.Decode(w, r, &req) {
		return
	}

	home, _ := os.UserHomeDir()
	skill, fieldErrs, err := h.service.Create(r.Context(), home, skills.WriteInput{
		Name:        req.Name,
		Description: req.Description,
		Body:        req.Body,
		Frontmatter: req.Frontmatter,
	})
	if err != nil {
		if errors.Is(err, skills.ErrConflict) {
			httpjson.Conflict(w, err.Error())
			return
		}
		httpjson.ServerError(w, err)
		return
	}
	if skill == nil {
		httpjson.Write(w, http.StatusBadRequest, ValidationErrorResponse{
			Errors: toFieldErrorDTOs(fieldErrs),
		})
		return
	}

	httpjson.Write(w, http.StatusCreated, WriteResponse{
		Skill:    toSkillDTO(skill),
		Warnings: toFieldErrorDTOs(fieldErrs),
	})
}

// Update handles PUT /api/skills/items/{name}.
func (h *Handler) Update(w http.ResponseWriter, r *http.Request) {
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

	var req WriteRequest
	if !httpjson.Decode(w, r, &req) {
		return
	}

	home, _ := os.UserHomeDir()
	skill, fieldErrs, err := h.service.Update(r.Context(), home, name, skills.WriteInput{
		Name:        req.Name,
		Description: req.Description,
		Body:        req.Body,
		Frontmatter: req.Frontmatter,
	})
	if err != nil {
		if errors.Is(err, skills.ErrSkillNotFound) {
			httpjson.NotFound(w, "skill not found")
			return
		}
		if errors.Is(err, skills.ErrReadOnlySkill) {
			httpjson.Conflict(w, err.Error())
			return
		}
		httpjson.ServerError(w, err)
		return
	}
	if skill == nil {
		httpjson.Write(w, http.StatusBadRequest, ValidationErrorResponse{
			Errors: toFieldErrorDTOs(fieldErrs),
		})
		return
	}

	httpjson.OK(w, WriteResponse{
		Skill:    toSkillDTO(skill),
		Warnings: toFieldErrorDTOs(fieldErrs),
	})
}

// Delete handles DELETE /api/skills/items/{name}.
// Optional query param: ?force=true
func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
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

	force := r.URL.Query().Get("force") == "true"

	home, _ := os.UserHomeDir()
	err := h.service.Delete(r.Context(), home, name, force)
	if err != nil {
		if errors.Is(err, skills.ErrSkillNotFound) {
			httpjson.NotFound(w, "skill not found")
			return
		}
		if errors.Is(err, skills.ErrReadOnlySkill) {
			httpjson.Conflict(w, err.Error())
			return
		}
		if errors.Is(err, skills.ErrUnexpectedFiles) {
			httpjson.Write(w, http.StatusUnprocessableEntity, map[string]string{"error": err.Error()})
			return
		}
		httpjson.ServerError(w, err)
		return
	}

	httpjson.Success(w)
}

// Duplicate handles POST /api/skills/items/{name}/duplicate.
// Optional query param: ?project=<abs_path>
func (h *Handler) Duplicate(w http.ResponseWriter, r *http.Request) {
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
	skill, err := h.service.Duplicate(r.Context(), home, name, project)
	if err != nil {
		if errors.Is(err, skills.ErrSkillNotFound) {
			httpjson.NotFound(w, "skill not found")
			return
		}
		if errors.Is(err, skills.ErrInvalidName) {
			httpjson.BadRequest(w, err.Error())
			return
		}
		httpjson.ServerError(w, err)
		return
	}

	httpjson.Write(w, http.StatusCreated, WriteResponse{
		Skill: toSkillDTO(skill),
	})
}
