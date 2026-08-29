package sandbox

// noneBackend is the honest fallback: runs exactly as terminal.go always
// did before this package existed, and says so. This is a first-class,
// always-tested outcome (TestSandbox_FallsThroughToUnsandboxedAndSaysSo),
// not a silent downgrade -- see the package doc and
// docs/coding-agent-parity/03-sandboxed-execution.md's honesty contract.
type noneBackend struct{}

func (noneBackend) Name() string    { return "none" }
func (noneBackend) Sandboxed() bool { return false }

// wrap is the identity function: argv runs exactly as given, on the host,
// with no isolation beyond whatever the caller already set on the
// resulting *exec.Cmd (Dir, Env). CommandOpts.NetworkAllowed is
// deliberately unread here -- with no backend there is nothing to allow or
// deny, and the command reaches the network exactly as any host process
// would.
func (noneBackend) wrap(argv []string, _ CommandOpts) []string {
	return argv
}
