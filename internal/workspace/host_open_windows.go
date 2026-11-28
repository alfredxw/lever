//go:build windows

package workspace

import (
	"golang.org/x/sys/windows"
	"os"
)

const hostOpenFlags = os.O_RDONLY

func peerSingleLink(f *os.File, _ os.FileInfo) bool {
	var info windows.ByHandleFileInformation
	return windows.GetFileInformationByHandle(windows.Handle(f.Fd()), &info) == nil && info.NumberOfLinks == 1
}
