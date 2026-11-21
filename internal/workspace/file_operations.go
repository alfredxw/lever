package workspace

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"lever/internal/model"
)

// ChangeEntry shares the editor's write lock and confines all operations to the
// selected scope. Destinations must be new entries; copying never merges trees.
func ChangeEntry(root, path, operation, destination string) (model.FileEntry, error) {
	if err := validateEntryPath(path); err != nil {
		return model.FileEntry{}, err
	}
	fileWriteMu.Lock()
	defer fileWriteMu.Unlock()
	r, err := os.OpenRoot(root)
	if err != nil {
		return model.FileEntry{}, err
	}
	defer r.Close()
	info, err := r.Lstat(path)
	if err != nil {
		return model.FileEntry{}, err
	}
	if operation == "delete" {
		return model.FileEntry{}, r.RemoveAll(path)
	}
	if operation == "duplicate" {
		ext := filepath.Ext(path)
		if info.IsDir() || filepath.Base(path) == ext {
			ext = ""
		}
		base := strings.TrimSuffix(path, ext)
		for n := 1; ; n++ {
			suffix := " copy"
			if n > 1 {
				suffix += fmt.Sprintf(" %d", n)
			}
			destination = base + suffix + ext
			_, err := r.Lstat(destination)
			if os.IsNotExist(err) {
				break
			}
			if err != nil {
				return model.FileEntry{}, err
			}
		}
	} else if operation != "copy" && operation != "move" {
		return model.FileEntry{}, fmt.Errorf("%w: unknown file operation", ErrInvalidFile)
	}
	if err := validateEntryPath(destination); err != nil {
		return model.FileEntry{}, err
	}
	if destination == path || (info.IsDir() && strings.HasPrefix(destination, path+"/")) {
		return model.FileEntry{}, fmt.Errorf("%w: destination is inside the source", ErrInvalidFile)
	}
	// Resolve the parent within the root to also catch aliases into the source.
	parent, err := filepath.EvalSymlinks(filepath.Join(root, filepath.Dir(destination)))
	if err != nil {
		return model.FileEntry{}, err
	}
	if !Contains(root, parent) || (info.IsDir() && Contains(filepath.Join(root, path), parent)) {
		return model.FileEntry{}, fmt.Errorf("%w: invalid destination directory", ErrInvalidFile)
	}
	if _, err := r.Lstat(destination); !os.IsNotExist(err) {
		if err == nil {
			err = os.ErrExist
		}
		return model.FileEntry{}, err
	}
	if operation == "move" {
		err = renameEntry(r, path, destination)
	} else {
		err = copyEntry(r, path, destination)
	}
	if err != nil {
		return model.FileEntry{}, err
	}
	return model.FileEntry{Name: filepath.Base(destination), Path: destination, Directory: info.IsDir(), Size: info.Size()}, nil
}

// Preserve hidden entries, binary data, permissions and symlinks. Never follow
// symlinks while recursively copying, and remove only our own partial result.
func copyEntry(root *os.Root, source, destination string) (err error) {
	info, err := root.Lstat(source)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		target, err := root.Readlink(source)
		if err != nil {
			return err
		}
		return root.Symlink(target, destination)
	}
	if !info.IsDir() && !info.Mode().IsRegular() {
		return fmt.Errorf("%w: only files and directories can be copied", ErrInvalidFile)
	}
	src, err := root.Open(source)
	if err != nil {
		return err
	}
	defer src.Close()
	if info.IsDir() {
		if err = root.Mkdir(destination, info.Mode().Perm()|0700); err != nil {
			return err
		}
	} else {
		dst, openErr := root.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, info.Mode().Perm())
		if openErr != nil {
			return openErr
		}
		_, err = io.Copy(dst, src)
		closeErr := dst.Close()
		if err == nil {
			err = closeErr
		}
		if err != nil {
			_ = root.Remove(destination)
		}
		return err
	}
	defer func() {
		if err != nil {
			_ = root.RemoveAll(destination)
		}
	}()
	entries, err := src.ReadDir(-1)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if err = copyEntry(root, filepath.Join(source, entry.Name()), filepath.Join(destination, entry.Name())); err != nil {
			return err
		}
	}
	return root.Chmod(destination, info.Mode().Perm())
}
