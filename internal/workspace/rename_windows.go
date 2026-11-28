package workspace

import (
	"os"
	"path/filepath"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Unlike os.Root.Rename, this requests a rename without replacing the target.
func renameEntry(root *os.Root, source, destination string) (err error) {
	defer func() {
		if status, ok := err.(windows.NTStatus); ok {
			err = status.Errno()
		}
	}()
	from, err := root.Open(filepath.Dir(source))
	if err != nil {
		return err
	}
	defer from.Close()
	to, err := root.Open(filepath.Dir(destination))
	if err != nil {
		return err
	}
	defer to.Close()
	return renameEntryAt(from, to, filepath.Base(source), filepath.Base(destination))
}
func renameEntryAt(from, to *os.File, source, destination string) (err error) {

	name, err := windows.NewNTUnicodeString(filepath.Base(source))
	if err != nil {
		return err
	}
	attributes := windows.OBJECT_ATTRIBUTES{
		RootDirectory: windows.Handle(from.Fd()), ObjectName: name,
		Attributes: windows.OBJ_CASE_INSENSITIVE,
	}
	attributes.Length = uint32(unsafe.Sizeof(attributes))
	var handle windows.Handle
	var status windows.IO_STATUS_BLOCK
	err = windows.NtCreateFile(&handle, windows.DELETE|windows.SYNCHRONIZE, &attributes, &status, nil, 0,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, windows.FILE_OPEN,
		windows.FILE_OPEN_REPARSE_POINT|windows.FILE_OPEN_FOR_BACKUP_INTENT|windows.FILE_SYNCHRONOUS_IO_NONALERT, 0, 0)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(handle)
	newName, err := windows.UTF16FromString(filepath.Base(destination))
	if err != nil {
		return err
	}
	// FILE_RENAME_INFORMATION, with ReplaceIfExists left false.
	info := struct {
		ReplaceIfExists uint32
		RootDirectory   windows.Handle
		FileNameLength  uint32
		FileName        [windows.MAX_PATH]uint16
	}{RootDirectory: windows.Handle(to.Fd()), FileNameLength: uint32((len(newName) - 1) * 2)}
	if len(newName) > len(info.FileName) {
		return windows.ERROR_FILENAME_EXCED_RANGE
	}
	copy(info.FileName[:], newName)
	return windows.NtSetInformationFile(handle, &status, (*byte)(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)), windows.FileRenameInformation)
}
