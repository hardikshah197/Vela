package main

/*
#include <util.h>
*/
import "C"
import (
	"fmt"
	"os"
	"syscall"
	"unsafe"
)

// openPTY allocates a new PTY pair using cgo openpty().
// On macOS Sequoia, creack/pty's forkpty() is blocked for ad-hoc signed binaries,
// but cgo openpty() + Go's os/exec works fine.
func openPTY() (master, slave *os.File, err error) {
	var masterFd, slaveFd C.int
	if ret := C.openpty(&masterFd, &slaveFd, nil, nil, nil); ret != 0 {
		return nil, nil, fmt.Errorf("openpty failed")
	}
	master = os.NewFile(uintptr(masterFd), "pty-master")
	slave = os.NewFile(uintptr(slaveFd), "pty-slave")
	return master, slave, nil
}

// setWinSize sets the terminal window size on a PTY file descriptor.
func setWinSize(f *os.File, rows, cols uint16) error {
	ws := struct {
		Rows uint16
		Cols uint16
		X    uint16
		Y    uint16
	}{Rows: rows, Cols: cols}
	_, _, errno := syscall.Syscall(
		syscall.SYS_IOCTL,
		f.Fd(),
		uintptr(syscall.TIOCSWINSZ),
		uintptr(unsafe.Pointer(&ws)),
	)
	if errno != 0 {
		return errno
	}
	return nil
}
