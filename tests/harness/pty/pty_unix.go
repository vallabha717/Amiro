//go:build !windows

package pty

import (
	"os"

	"github.com/creack/pty"
)

type ptyDevice struct {
	master *os.File
	slave  *os.File
}

func openPTY(width, height int) (*ptyDevice, error) {
	ws := &pty.Winsize{
		Rows: uint16(height),
		Cols: uint16(width),
	}
	master, slave, err := pty.Open()
	if err != nil {
		return nil, err
	}
	if err := pty.Setsize(master, ws); err != nil {
		_ = master.Close()
		_ = slave.Close()
		return nil, err
	}
	return &ptyDevice{master: master, slave: slave}, nil
}

func (d *ptyDevice) Resize(width, height int) error {
	ws := &pty.Winsize{
		Rows: uint16(height),
		Cols: uint16(width),
	}
	return pty.Setsize(d.master, ws)
}

func (d *ptyDevice) Close() error {
	var err1, err2 error
	if d.slave != nil {
		err1 = d.slave.Close()
		d.slave = nil
	}
	if d.master != nil {
		err2 = d.master.Close()
		d.master = nil
	}
	if err1 != nil {
		return err1
	}
	return err2
}
