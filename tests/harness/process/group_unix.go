//go:build !windows

package process

import (
	"os/exec"
	"syscall"
)

// setProcessGroup puts the child in its own process group, so a signal sent
// to -pid reaches everything it spawned.
//
// This is what makes stopping Tauri stop the Go sidecar it launched. Without
// it the parent dies, the child keeps the port, and the next test's
// teardown assertion fails somewhere unrelated to the cause.
func setProcessGroup(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
}

// terminate sends SIGTERM to the whole group, falling back to the process
// alone if the group is gone.
func terminate(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	if err := syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM); err != nil {
		_ = cmd.Process.Signal(syscall.SIGTERM)
	}
}

// kill is terminate's escalation: SIGKILL, which cannot be caught, ignored
// or blocked.
func kill(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	if err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); err != nil {
		_ = cmd.Process.Kill()
	}
}
