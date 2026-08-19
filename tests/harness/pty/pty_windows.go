//go:build windows

package pty

import (
	"errors"
	"os"
)

type ptyDevice struct {
	master *os.File
	slave  *os.File
}

func openPTY(width, height int) (*ptyDevice, error) {
	return nil, errors.New("PTY is not supported on Windows in this suite (scoped to Unix)")
}

func (d *ptyDevice) Resize(width, height int) error {
	return errors.New("PTY is not supported on Windows in this suite (scoped to Unix)")
}

func (d *ptyDevice) Close() error {
	return nil
}
