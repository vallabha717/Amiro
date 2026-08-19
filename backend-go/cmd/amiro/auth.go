package main

import (
	"bufio"
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/charmbracelet/x/term"

	"amiro/backend/internal/config"
	"amiro/backend/internal/tui/client"
)

func runAuth(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: amiro auth <login|logout|whoami>")
	}
	sub, rest := args[0], args[1:]
	switch sub {
	case "login":
		return authLogin(rest)
	case "logout":
		return authLogout(rest)
	case "whoami":
		return authWhoami(rest)
	default:
		return fmt.Errorf("amiro auth: unknown subcommand %q", sub)
	}
}

// authLogin signs in against whatever backend attach-or-embed finds for
// this app-data dir and stores the resulting session (§2.5). A server with
// no accounts yet registers instead of failing a login that could never
// succeed -- the natural first run on a fresh install.
func authLogin(args []string) error {
	fs := flag.NewFlagSet("amiro auth login", flag.ContinueOnError)
	email := fs.String("email", "", "account email")
	password := fs.String("password", "", "account password (prompted if omitted)")
	name := fs.String("name", "", "display name, for a new account")
	connectURL := fs.String("connect", "", "sign in against the server at this URL instead of attach-or-embed discovery (requires --token)")
	connectToken := fs.String("token", "", "the server's shared secret, required with --connect")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *connectURL == "" && *connectToken != "" {
		return fmt.Errorf("--token has no effect without --connect")
	}

	ctx := context.Background()
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("config: %w", err)
	}

	t, err := resolveConnection(ctx, cfg, *connectURL, *connectToken)
	if err != nil {
		return err
	}
	defer t.Close()

	if *email == "" {
		*email, err = prompt("Email: ")
		if err != nil {
			return err
		}
	}

	firstUser, err := t.Client.IsFirstUser(ctx)
	if err != nil {
		return fmt.Errorf("checking account status: %w", err)
	}

	if *password == "" {
		*password, err = promptPassword("Password: ")
		if err != nil {
			return err
		}
	}

	var token string
	if firstUser {
		if *name == "" {
			*name, err = prompt("Name: ")
			if err != nil {
				return err
			}
		}
		token, err = t.Client.Register(ctx, *name, *email, *password)
		if err != nil {
			return fmt.Errorf("registering: %w", err)
		}
	} else {
		token, err = t.Client.Login(ctx, *email, *password)
		if err != nil {
			return fmt.Errorf("signing in: %w", err)
		}
	}

	if err := secretsStore(cfg).Set(ctx, t.sessionKey, token); err != nil {
		return fmt.Errorf("storing session: %w", err)
	}

	name2, email2, err := t.Client.WithSessionToken(token).Whoami(ctx)
	if err != nil {
		return fmt.Errorf("verifying session: %w", err)
	}
	fmt.Printf("Signed in as %s <%s>\n", name2, email2)
	return nil
}

// authLogout deletes the stored session. It also tries to invalidate it
// server-side, but only against a server that's already running -- logout
// has no business starting a backend just to shut it back down. --connect
// logs out of that specific server's stored session rather than the
// attach-or-embed one; it does not start or discover anything either, only
// attempt a live round trip if --token is enough to reach it.
func authLogout(args []string) error {
	fs := flag.NewFlagSet("amiro auth logout", flag.ContinueOnError)
	connectURL := fs.String("connect", "", "sign out of the server at this URL instead of the attach-or-embed one")
	connectToken := fs.String("token", "", "the server's shared secret, used only for the best-effort server-side invalidation")
	if err := fs.Parse(args); err != nil {
		return err
	}

	ctx := context.Background()
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("config: %w", err)
	}
	store := secretsStore(cfg)

	sessionKey := sessionSecretKey
	if *connectURL != "" {
		sessionKey = sessionKeyForServer(*connectURL)
	}

	token, ok, err := store.Get(ctx, sessionKey)
	if err != nil {
		return fmt.Errorf("reading stored session: %w", err)
	}
	if !ok {
		fmt.Println("not signed in")
		return nil
	}

	if *connectURL != "" {
		if c, err := client.Connect(ctx, *connectURL, *connectToken); err == nil {
			_ = c.WithSessionToken(token).Logout(ctx)
		}
	} else if c, live := client.Discover(ctx, cfg.AppDataDir); live {
		_ = c.WithSessionToken(token).Logout(ctx)
	}

	if err := store.Delete(ctx, sessionKey); err != nil {
		return fmt.Errorf("removing stored session: %w", err)
	}
	fmt.Println("signed out")
	return nil
}

// authWhoami reports the stored session's account without starting a
// server unnecessarily -- but does need one to actually validate the token
// server-side, so attach-or-embed still applies. --connect checks that
// specific server's stored session instead.
func authWhoami(args []string) error {
	fs := flag.NewFlagSet("amiro auth whoami", flag.ContinueOnError)
	connectURL := fs.String("connect", "", "check the session stored for the server at this URL instead of the attach-or-embed one (requires --token)")
	connectToken := fs.String("token", "", "the server's shared secret, required with --connect")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *connectURL == "" && *connectToken != "" {
		return fmt.Errorf("--token has no effect without --connect")
	}

	ctx := context.Background()
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("config: %w", err)
	}
	store := secretsStore(cfg)

	sessionKey := sessionSecretKey
	if *connectURL != "" {
		sessionKey = sessionKeyForServer(*connectURL)
	}

	token, ok, err := store.Get(ctx, sessionKey)
	if err != nil {
		return fmt.Errorf("reading stored session: %w", err)
	}
	if !ok {
		fmt.Println("not signed in")
		return nil
	}

	t, err := resolveConnection(ctx, cfg, *connectURL, *connectToken)
	if err != nil {
		return err
	}
	defer t.Close()

	name, email, err := t.Client.WithSessionToken(token).Whoami(ctx)
	if err != nil {
		fmt.Println("stored session is no longer valid -- run `amiro auth login`")
		return nil
	}
	fmt.Printf("%s <%s>\n", name, email)
	return nil
}

func prompt(label string) (string, error) {
	fmt.Print(label)
	line, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil && err != io.EOF {
		return "", err
	}
	return strings.TrimSpace(line), nil
}

func promptPassword(label string) (string, error) {
	fmt.Print(label)
	b, err := term.ReadPassword(os.Stdin.Fd())
	fmt.Println()
	if err != nil {
		return "", fmt.Errorf("reading password: %w", err)
	}
	return strings.TrimSpace(string(b)), nil
}
