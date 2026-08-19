package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"amiro/tests/harness/config"
)

// cmdConfig owns config.example.yaml: generating it from defaults.go, and
// checking it has not drifted.
//
// The generator is the mechanism that keeps "the documented default" and
// "the actual default" from separating. The usual way a config file's
// comments become lies is that nobody regenerates them, so nothing here is
// hand-maintained.
func cmdConfig(args []string) int {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "usage: amirotest config example [--check] [--stdout]")
		return exitConfig
	}
	switch args[0] {
	case "example":
		return cmdConfigExample(args[1:])
	case "show":
		return cmdConfigShow(args[1:])
	default:
		fmt.Fprintf(os.Stderr, "amirotest config: unknown subcommand %q (want: example, show)\n", args[0])
		return exitConfig
	}
}

func cmdConfigExample(args []string) int {
	fs := flag.NewFlagSet("config example", flag.ContinueOnError)
	var common commonFlags
	common.register(fs)
	check := fs.Bool("check", false, "exit non-zero if the committed file has drifted, and write nothing")
	toStdout := fs.Bool("stdout", false, "print instead of writing the file")
	if err := fs.Parse(args); err != nil {
		return exitConfig
	}

	baseDir := common.baseDir
	if baseDir == "" {
		var err error
		baseDir, err = config.DiscoverBaseDir("")
		if err != nil {
			fmt.Fprintf(os.Stderr, "amirotest: %v\n", err)
			return exitConfig
		}
	}
	generated := config.Example()

	if *toStdout {
		fmt.Print(generated)
		return exitOK
	}

	path := filepath.Join(baseDir, config.ExampleName)
	if *check {
		existing, err := os.ReadFile(path)
		if err != nil {
			fmt.Fprintf(os.Stderr, "amirotest: %s does not exist; run `amirotest config example`\n", path)
			return exitFailed
		}
		if string(existing) != generated {
			fmt.Fprintf(os.Stderr, "amirotest: %s has drifted from harness/config/defaults.go.\n"+
				"Run `amirotest config example` and commit the result.\n", path)
			return exitFailed
		}
		fmt.Printf("%s is up to date.\n", path)
		return exitOK
	}

	if err := os.WriteFile(path, []byte(generated), 0o644); err != nil {
		fmt.Fprintf(os.Stderr, "amirotest: %v\n", err)
		return exitInfra
	}
	fmt.Printf("wrote %s\n", path)
	return exitOK
}

// cmdConfigShow prints the fully resolved configuration, redacted -- the
// answer to "what would this run actually use?" without starting one.
func cmdConfigShow(args []string) int {
	fs := flag.NewFlagSet("config show", flag.ContinueOnError)
	var common commonFlags
	common.register(fs)
	if err := fs.Parse(args); err != nil {
		return exitConfig
	}
	res, code := loadConfig(common)
	if code != exitOK {
		return code
	}
	redacted := res.Config.Redacted()
	out, err := yamlMarshal(redacted)
	if err != nil {
		fmt.Fprintf(os.Stderr, "amirotest: %v\n", err)
		return exitInfra
	}
	if len(res.Sources) == 0 {
		fmt.Println("# no config.yaml -- every value below is a default")
	} else {
		for _, s := range res.Sources {
			fmt.Printf("# from %s\n", s)
		}
	}
	fmt.Print(string(out))
	return exitOK
}
