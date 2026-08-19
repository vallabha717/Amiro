//go:build windows

package process

import (
	"os/exec"
	"syscall"
)

// Windows has no process groups in the POSIX sense. CREATE_NEW_PROCESS_GROUP
// gives the child its own group for console control events, which is the
// closest equivalent available without a Job Object.
//
// The gap is real and worth stating rather than hiding: a grandchild that
// detaches from the console is not reached by the stop below. Teardown's
// AssertPortFree is what catches that case, which is why it is a separate
// assertion from AssertStopped rather than folded into it.
func setProcessGroup(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.CreationFlags |= syscall.CREATE_NEW_PROCESS_GROUP
}

// terminate has no SIGTERM to send. Go's os.Process.Signal only supports
// os.Kill on Windows, so the graceful step and the forceful one are the
// same call; the caller's grace period simply elapses first.
func terminate(cmd *exec.Cmd) {
	if cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
}

func kill(cmd *exec.Cmd) {
	if cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
}
