package cassette

import (
	"os"
	"path/filepath"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// TTLReport represents the staleness inspection for a single cassette.
type TTLReport struct {
	Path      string    `json:"path"`
	Recorded  time.Time `json:"recorded"`
	TTLDays   int       `json:"ttlDays"`
	AgeDays   int       `json:"ageDays"`
	IsExpired bool      `json:"isExpired"`
}

// CheckTTL walks cassetteDir and reports staleness against now.
func CheckTTL(cassetteDir string, now time.Time) ([]TTLReport, error) {
	var reports []TTLReport
	if _, err := os.Stat(cassetteDir); os.IsNotExist(err) {
		return reports, nil
	}

	err := filepath.Walk(cassetteDir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() || (!strings.HasSuffix(path, ".yaml") && !strings.HasSuffix(path, ".yml")) {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		var c Cassette
		if err := yaml.Unmarshal(data, &c); err != nil {
			return nil
		}

		ttl := c.Meta.GetTTLDays()
		recorded := c.Meta.GetRecorded()
		if recorded.IsZero() {
			recorded = now
		}

		age := int(now.Sub(recorded).Hours() / 24)
		if age < 0 {
			age = 0
		}

		rel, _ := filepath.Rel(cassetteDir, path)
		reports = append(reports, TTLReport{
			Path:      filepath.ToSlash(rel),
			Recorded:  recorded,
			TTLDays:   ttl,
			AgeDays:   age,
			IsExpired: age > ttl,
		})
		return nil
	})

	return reports, err
}
