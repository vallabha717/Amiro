package auth

import (
	"context"
	"errors"
	"strings"
	"time"

	"gorm.io/gorm"

	"betterchatbot/backend/internal/db/models"
)

var (
	ErrEmailTaken              = errors.New("auth: email already registered")
	ErrInvalidCredentials      = errors.New("auth: invalid email or password")
	ErrSessionNotFound         = errors.New("auth: session not found")
	ErrSessionExpired          = errors.New("auth: session expired")
	ErrUserNotFound            = errors.New("auth: user not found")
	ErrCurrentPasswordRequired = errors.New("auth: current password is required")
	ErrUserBanned              = errors.New("auth: this account has been banned")
)

// DesktopDefaultUserEmail identifies the single local user desktop builds
// auto-provision and auto-login on first run (plan section 3's resolved
// decision) -- a fixed, well-known address rather than one derived from OS
// username, so it stays stable across machines/rebuilds.
const DesktopDefaultUserEmail = "local@betterchatbot.desktop"

// Service implements the one shared user/session model plan section 3
// resolved on: bcrypt passwords, plain random session tokens, no
// JWT/OAuth machinery, used identically by both the desktop auto-login
// path and a real web deployment's register/login flow.
type Service struct {
	db *gorm.DB
}

func NewService(db *gorm.DB) *Service {
	return &Service{db: db}
}

func normalizeEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}

// IsFirstUser reports whether the instance has no accounts at all yet, so
// the sign-in screen can skip straight to sign-up instead of offering
// credentials that cannot possibly match anything. Ports better-chatbot's
// getIsFirstUser() (lib/auth/auth-instance.ts), which the TS app read
// server-side at render time; here it needs a route of its own because the
// frontend is fully client-rendered (see src/lib/backend/auth-gate.tsx).
//
// Deliberately not cached the way the TS version memoizes a `false`: this
// counts one indexed table on a local SQLite file, and a cache would have
// to be invalidated by Register anyway.
func (s *Service) IsFirstUser(ctx context.Context) (bool, error) {
	var count int64
	if err := s.db.WithContext(ctx).Model(&models.User{}).Count(&count).Error; err != nil {
		return false, err
	}
	return count == 0, nil
}

func (s *Service) Register(ctx context.Context, name, email, password string) (*models.User, error) {
	email = normalizeEmail(email)

	var existing models.User
	err := s.db.WithContext(ctx).Where("email = ?", email).First(&existing).Error
	if err == nil {
		return nil, ErrEmailTaken
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, err
	}

	hash, err := hashPassword(password)
	if err != nil {
		return nil, err
	}

	// First account created on a fresh instance becomes the admin, matching
	// better-chatbot's user-creation hook (auth-instance.ts). Without this
	// nothing ever sets role="admin", so the (chat)/(admin) route group and
	// every RequireAdmin route were permanently unreachable.
	role := "user"
	if first, err := s.IsFirstUser(ctx); err != nil {
		return nil, err
	} else if first {
		role = "admin"
	}

	user := &models.User{
		Name:          name,
		Email:         email,
		EmailVerified: false,
		Password:      &hash,
		Role:          role,
	}
	if err := s.db.WithContext(ctx).Create(user).Error; err != nil {
		return nil, err
	}
	return user, nil
}

func (s *Service) CreateSession(ctx context.Context, userID, ipAddress, userAgent string) (*models.Session, error) {
	token, err := newSessionToken()
	if err != nil {
		return nil, err
	}
	session := &models.Session{
		Token:     token,
		UserID:    userID,
		ExpiresAt: time.Now().Add(SessionTTL),
	}
	if ipAddress != "" {
		session.IPAddress = &ipAddress
	}
	if userAgent != "" {
		session.UserAgent = &userAgent
	}
	if err := s.db.WithContext(ctx).Create(session).Error; err != nil {
		return nil, err
	}
	return session, nil
}

func (s *Service) Login(ctx context.Context, email, password, ipAddress, userAgent string) (*models.User, *models.Session, error) {
	email = normalizeEmail(email)

	var user models.User
	if err := s.db.WithContext(ctx).Where("email = ?", email).First(&user).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil, ErrInvalidCredentials
		}
		return nil, nil, err
	}

	if user.Password == nil || !verifyPassword(*user.Password, password) {
		return nil, nil, ErrInvalidCredentials
	}

	// Better Auth's ban plugin blocks sign-in for a banned user (unless
	// BanExpires has already passed) -- ValidateSession intentionally does
	// NOT re-check this on every request (an admin's own revokeUserSessions
	// call, ported in admin's UpdateBanStatus, is what actually ends an
	// already-live session immediately; this only stops a *new* login).
	if user.Banned != nil && *user.Banned && (user.BanExpires == nil || time.Now().Before(*user.BanExpires)) {
		return nil, nil, ErrUserBanned
	}

	session, err := s.CreateSession(ctx, user.ID, ipAddress, userAgent)
	if err != nil {
		return nil, nil, err
	}
	return &user, session, nil
}

func (s *Service) ValidateSession(ctx context.Context, token string) (*models.User, *models.Session, error) {
	var session models.Session
	if err := s.db.WithContext(ctx).Where("token = ?", token).First(&session).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil, ErrSessionNotFound
		}
		return nil, nil, err
	}

	if time.Now().After(session.ExpiresAt) {
		return nil, nil, ErrSessionExpired
	}

	var user models.User
	if err := s.db.WithContext(ctx).First(&user, "id = ?", session.UserID).Error; err != nil {
		return nil, nil, err
	}

	return &user, &session, nil
}

func (s *Service) Logout(ctx context.Context, token string) error {
	return s.db.WithContext(ctx).Where("token = ?", token).Delete(&models.Session{}).Error
}

// SetPassword backs the user-settings "change password" flow. When the
// account already has a password, currentPassword must verify against it
// first (the same guard the original TS route's changePassword action
// enforces) -- when it doesn't (e.g. the desktop auto-provisioned local
// user, which never gets one), currentPassword is not required, matching
// "set a password for the first time" rather than "change" it.
func (s *Service) SetPassword(ctx context.Context, userID, currentPassword, newPassword string) error {
	var user models.User
	if err := s.db.WithContext(ctx).First(&user, "id = ?", userID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrUserNotFound
		}
		return err
	}

	if user.Password != nil && *user.Password != "" {
		if currentPassword == "" {
			return ErrCurrentPasswordRequired
		}
		if !verifyPassword(*user.Password, currentPassword) {
			return ErrInvalidCredentials
		}
	}

	hash, err := hashPassword(newPassword)
	if err != nil {
		return err
	}
	return s.db.WithContext(ctx).Model(&models.User{}).Where("id = ?", userID).
		Updates(map[string]interface{}{"password": hash, "updated_at": time.Now()}).Error
}

// EnsureDesktopDefaultUser finds or creates the single local user desktop
// builds run as, and issues it a fresh session -- called once at sidecar
// startup so there is still no login screen shown by default on desktop,
// per plan section 3's resolved decision. Previous sessions for that user
// are cleared first so restarts don't pile up stale rows.
func (s *Service) EnsureDesktopDefaultUser(ctx context.Context) (*models.User, *models.Session, error) {
	var user models.User
	err := s.db.WithContext(ctx).Where("email = ?", DesktopDefaultUserEmail).First(&user).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		user = models.User{
			Name:          "Local User",
			Email:         DesktopDefaultUserEmail,
			EmailVerified: true,
			Role:          "user",
		}
		if err := s.db.WithContext(ctx).Create(&user).Error; err != nil {
			return nil, nil, err
		}
	} else if err != nil {
		return nil, nil, err
	}

	if err := s.db.WithContext(ctx).Where("user_id = ?", user.ID).Delete(&models.Session{}).Error; err != nil {
		return nil, nil, err
	}

	session, err := s.CreateSession(ctx, user.ID, "", "desktop")
	if err != nil {
		return nil, nil, err
	}
	return &user, session, nil
}
