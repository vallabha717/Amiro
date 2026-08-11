// Package user holds the small pieces of user-profile data shared across
// chat/prompt building that don't need their own repository layer of
// their own. The api/user/** routes themselves live in internal/api/user
// over repository.UserRepository (Phase 6); this package holds the shared
// Preferences type both sides decode.
package user

import (
	"encoding/json"

	"gorm.io/datatypes"
)

// Preferences ports UserPreferences (src/types/user.ts:7).
type Preferences struct {
	DisplayName          string `json:"displayName,omitempty"`
	Profession           string `json:"profession,omitempty"`
	ResponseStyleExample string `json:"responseStyleExample,omitempty"`
	BotName              string `json:"botName,omitempty"`
}

// ParsePreferences decodes a User.Preferences JSON column. A nil/empty
// column (never set) or malformed JSON both resolve to nil, matching the
// TS repository's `preferences: UserPreferences | null`.
func ParsePreferences(raw datatypes.JSON) *Preferences {
	if len(raw) == 0 {
		return nil
	}
	var p Preferences
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil
	}
	return &p
}
