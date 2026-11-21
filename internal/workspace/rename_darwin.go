package workspace

import (
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

func renameEntry(root *os.Root, source, destination string) error {
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
	return unix.RenameatxNp(int(from.Fd()), filepath.Base(source), int(to.Fd()), filepath.Base(destination), unix.RENAME_EXCL)
}
