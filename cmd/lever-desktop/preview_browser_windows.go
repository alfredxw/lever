package main

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

func openInSystemBrowser(fileURL string) error {
	const assocIsProtocol, assocExecutable = 0x1000, 2
	query := windows.NewLazySystemDLL("shlwapi.dll").NewProc("AssocQueryStringW")
	scheme, _ := windows.UTF16PtrFromString("https")
	verb, _ := windows.UTF16PtrFromString("open")
	var executable [32768]uint16
	length := uint32(len(executable))
	result, _, _ := query.Call(assocIsProtocol, assocExecutable, uintptr(unsafe.Pointer(scheme)),
		uintptr(unsafe.Pointer(verb)), uintptr(unsafe.Pointer(&executable[0])), uintptr(unsafe.Pointer(&length)))
	if result != 0 || executable[0] == 0 {
		return fmt.Errorf("cannot resolve the default browser (HRESULT %#x)", result)
	}
	argument, err := windows.UTF16PtrFromString(fileURL)
	if err != nil {
		return err
	}
	return windows.ShellExecute(0, verb, &executable[0], argument, nil, windows.SW_SHOWNORMAL)
}
