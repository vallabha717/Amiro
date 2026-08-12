// Package auth mirrors src/app/api/auth/[...all]/route.ts -- the HTTP
// surface over internal/auth's shared user/session model (better-auth is
// not vendored; plan section 3's resolved decision).
package auth

import (
	"encoding/json"
	"errors"
	"net/http"

	"betterchatbot/backend/internal/auth"
	"betterchatbot/backend/internal/db/models"
)

type userResponse struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Email string `json:"email"`
	Role  string `json:"role"`
}

func toUserResponse(u *models.User) userResponse {
	return userResponse{ID: u.ID, Name: u.Name, Email: u.Email, Role: u.Role}
}

type sessionResponse struct {
	User  userResponse `json:"user"`
	Token string       `json:"token"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

// Status handles GET /api/auth/status. Unauthenticated by design -- it is
// the one thing the sign-in screen needs to know *before* anyone can sign
// in, and it leaks only "does this instance have any account yet", which is
// exactly what the sign-in form already reveals by accepting or rejecting a
// login attempt.
func Status(service *auth.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		isFirstUser, err := service.IsFirstUser(r.Context())
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to read registration status")
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"isFirstUser": isFirstUser})
	}
}

// Register handles POST /api/auth/register.
func Register(service *auth.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Name     string `json:"name"`
			Email    string `json:"email"`
			Password string `json:"password"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		if req.Email == "" || req.Password == "" || req.Name == "" {
			writeError(w, http.StatusBadRequest, "name, email, and password are required")
			return
		}

		user, err := service.Register(r.Context(), req.Name, req.Email, req.Password)
		if err != nil {
			if errors.Is(err, auth.ErrEmailTaken) {
				writeError(w, http.StatusConflict, "email already registered")
				return
			}
			writeError(w, http.StatusInternalServerError, "registration failed")
			return
		}

		session, err := service.CreateSession(r.Context(), user.ID, r.RemoteAddr, r.UserAgent())
		if err != nil {
			writeError(w, http.StatusInternalServerError, "registration failed")
			return
		}

		writeJSON(w, http.StatusCreated, sessionResponse{User: toUserResponse(user), Token: session.Token})
	}
}

// Login handles POST /api/auth/login.
func Login(service *auth.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Email    string `json:"email"`
			Password string `json:"password"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body")
			return
		}

		user, session, err := service.Login(r.Context(), req.Email, req.Password, r.RemoteAddr, r.UserAgent())
		if err != nil {
			if errors.Is(err, auth.ErrUserBanned) {
				writeError(w, http.StatusForbidden, err.Error())
				return
			}
			writeError(w, http.StatusUnauthorized, "invalid email or password")
			return
		}

		writeJSON(w, http.StatusOK, sessionResponse{User: toUserResponse(user), Token: session.Token})
	}
}

// Logout handles POST /api/auth/logout. Requires auth.RequireSession.
func Logout(service *auth.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token, ok := auth.BearerToken(r)
		if !ok {
			writeError(w, http.StatusBadRequest, "missing bearer token")
			return
		}
		if err := service.Logout(r.Context(), token); err != nil {
			writeError(w, http.StatusInternalServerError, "logout failed")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// Me handles GET /api/auth/session. Requires auth.RequireSession.
func Me(w http.ResponseWriter, r *http.Request) {
	user, ok := auth.UserFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	writeJSON(w, http.StatusOK, toUserResponse(user))
}
