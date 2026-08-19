# Amiro TUI Test Suites

The TUI test suite exercises Amiro's terminal user interface against real virtual pseudo-terminals (PTY), testing interactive chat streaming, keyboard input, palettes, pickers, approval dialogs, flag validation, configuration cascades, authentication commands, headless execution, and ANSI/Unicode terminal rendering.

## Structure

```
tests/suites/tui/
├── approval/     # Tool approval prompts (approve once 'y', deny 'n', always allow 'a')
├── auth/         # CLI auth commands (login, whoami, logout, server key isolation)
├── chat/         # Live message streaming, multi-turn interactions, interrupt (ctrl+c), scrollback (pgup/pgdown)
├── config/       # Precedence hierarchy (CLI flags → project config → user config → env → defaults), malformed YAML resilience
├── headless/     # Non-interactive CLI ('amiro run' text streaming, --json output, exit code contract 0/1/2, --yes auto-approval)
├── launch/       # Attach to running backend vs embed server, flag validation and directory flags (-C)
├── palette/      # Command palette (ctrl+p, typing '/', Tab completion, @-mentions)
├── pickers/      # Thread switcher (ctrl+t) and Model picker (ctrl+o)
└── rendering/    # Terminal dimensions, resize reflow, Unicode/CJK double-width characters, raw ANSI safety, golden screens
```

## Running

```bash
# Run all TUI suites through amirotest
go run ./cmd/amirotest run --surface tui

# Run a specific feature
go run ./cmd/amirotest run --surface tui --feature chat

# Run via standard go test
go test -race ./suites/tui/...
```
