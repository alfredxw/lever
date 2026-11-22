package device

import (
	"context"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	powerKernel        = windows.NewLazySystemDLL("kernel32.dll")
	powerCreateRequest = powerKernel.NewProc("PowerCreateRequest")
	powerSetRequest    = powerKernel.NewProc("PowerSetRequest")
	powerClearRequest  = powerKernel.NewProc("PowerClearRequest")
)

// PreventIdleSleep uses a process-owned handle so independent turns can
// acquire and release requests from any goroutine.
func PreventIdleSleep(_ context.Context) (func(), error) {
	const powerRequestContextSimpleString = 1
	const powerRequestSystemRequired = 1
	reason, _ := windows.UTF16PtrFromString("Lever is running an agent")
	// REASON_CONTEXT with the simple string arm of the union.
	request := struct {
		version, flags uint32
		reason         *uint16
		_              [2]uint32
		_              uintptr
	}{flags: powerRequestContextSimpleString, reason: reason}
	h, _, err := powerCreateRequest.Call(uintptr(unsafe.Pointer(&request)))
	handle := windows.Handle(h)
	if handle == windows.InvalidHandle || handle == 0 {
		return nil, err
	}
	if ok, _, err := powerSetRequest.Call(h, powerRequestSystemRequired); ok == 0 {
		_ = windows.CloseHandle(handle)
		return nil, err
	}
	return sync.OnceFunc(func() {
		powerClearRequest.Call(h, powerRequestSystemRequired)
		_ = windows.CloseHandle(handle)
	}), nil
}
