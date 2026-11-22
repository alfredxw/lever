package device

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/godbus/dbus/v5"
	"golang.org/x/sys/unix"
)

// logind keeps the inhibitor for as long as this process holds the returned
// file descriptor. No desktop session or long-lived D-Bus connection is needed.
func PreventIdleSleep(ctx context.Context) (func(), error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	bus, err := dbus.ConnectSystemBus(dbus.WithContext(ctx))
	if err != nil {
		return nil, err
	}
	defer bus.Close()
	if !bus.SupportsUnixFDs() {
		return nil, errors.New("the system bus cannot pass a sleep inhibitor file descriptor")
	}
	manager := bus.Object("org.freedesktop.login1", "/org/freedesktop/login1")
	var fd dbus.UnixFD
	err = manager.CallWithContext(ctx, "org.freedesktop.login1.Manager.Inhibit", 0,
		"sleep", "Lever", "Running an agent", "block").Store(&fd)
	if err != nil {
		return nil, err
	}
	unix.CloseOnExec(int(fd))
	return sync.OnceFunc(func() { _ = unix.Close(int(fd)) }), nil
}
