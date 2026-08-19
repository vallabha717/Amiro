package search

import "fmt"

// Kind is a provider's stable identifier: the string stored in the database,
// sent by the admin UI, and matched below.
type Kind string

const (
	KindBrave  Kind = "brave"
	KindTavily Kind = "tavily"
	KindExa    Kind = "exa"
	KindSerper Kind = "serper"
)

// Spec describes one provider to the UI and to validation.
//
// Kept here rather than duplicated in the frontend because the two facts the
// UI needs -- what credential to prompt for, and whether this provider can
// extract page content -- are properties of the adapter directly below it.
// A provider added to this table and nowhere else still renders a correct
// form and a correct capability badge.
type Spec struct {
	Kind Kind `json:"kind"`
	// Label is the human name, for the admin UI's provider picker.
	Label string `json:"label"`
	// Extracts reports whether this provider implements ContentExtractor,
	// i.e. whether choosing it keeps the web_content tool working.
	Extracts bool `json:"extracts"`
	// FreeTier is what a user gets without paying, stated so the choice can
	// be made in the UI rather than in four pricing pages.
	FreeTier string `json:"freeTier"`
	// Docs is where to get a key.
	Docs string `json:"docs"`
}

// Specs is every supported provider, in the order the UI should offer them.
//
// Brave first because it is the general-purpose default: an independent
// index, and a free tier that needs no card. Tavily second because it is the
// only free-tier option that also extracts content, so it is the one that
// keeps both tools working on its own.
var Specs = []Spec{
	{
		Kind:     KindBrave,
		Label:    "Brave Search",
		Extracts: false,
		FreeTier: "2,000 queries/month, no card required",
		Docs:     "https://brave.com/search/api/",
	},
	{
		Kind:     KindTavily,
		Label:    "Tavily",
		Extracts: true,
		FreeTier: "1,000 credits/month, no card required",
		Docs:     "https://app.tavily.com/",
	},
	{
		Kind:     KindExa,
		Label:    "Exa",
		Extracts: true,
		FreeTier: "$10 of starting credit",
		Docs:     "https://dashboard.exa.ai/",
	},
	{
		Kind:     KindSerper,
		Label:    "Serper (Google)",
		Extracts: false,
		FreeTier: "2,500 one-off credits",
		Docs:     "https://serper.dev/",
	},
}

// SpecFor returns the spec for a provider id.
func SpecFor(kind string) (Spec, bool) {
	for _, s := range Specs {
		if string(s.Kind) == kind {
			return s, true
		}
	}
	return Spec{}, false
}

// New builds the adapter for a stored config.
//
// An unknown provider is an error, never a silent fallback to some default.
// The previous version of this switch ended in `default:` returning the
// DuckDuckGo scraper, which meant a typo in the provider field -- or a row
// left behind by a removed provider -- sent every search to a different
// engine than the one named on screen, with nothing anywhere saying so.
func New(kind, apiKey string) (Provider, error) {
	switch Kind(kind) {
	case KindBrave:
		return NewBraveProvider(apiKey), nil
	case KindTavily:
		return NewTavilyProvider(apiKey), nil
	case KindExa:
		return NewExaProvider(apiKey), nil
	case KindSerper:
		return NewSerperProvider(apiKey), nil
	}
	return nil, fmt.Errorf("unknown search provider %q -- supported: %s", kind, SupportedList())
}

// SupportedList is the provider ids, for error messages.
func SupportedList() string {
	out := ""
	for i, s := range Specs {
		if i > 0 {
			out += ", "
		}
		out += string(s.Kind)
	}
	return out
}
