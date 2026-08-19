//go:build windows

package logging

import "os"

// lockFile is a no-op on Windows.
//
// A file opened with FILE_APPEND_DATA has its writes serialised by the
// kernel against the current end of file, so a single Write of a whole line
// cannot be torn by a concurrent appender -- which is the property
// appendLine actually needs. LockFileEx would add nothing here except a
// second way to fail.
func lockFile(*os.File) func() { return func() {} }
