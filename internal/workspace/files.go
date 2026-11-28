package workspace

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"lever/internal/device"
	"lever/internal/model"
)

const MaxFileBytes = 2 << 20

var (
	ErrFileConflict       = errors.New("file changed on disk; reload before saving")
	ErrInvalidFile        = errors.New("file cannot be edited")
	ErrUnsupportedPreview = errors.New("file format is not supported for text preview")
	fileWriteMu           sync.Mutex
)

func Canonical(path string) (string, error) {
	if path == "~" || strings.HasPrefix(path, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		path = filepath.Join(home, strings.TrimPrefix(path[1:], "/"))
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	abs, err = filepath.EvalSymlinks(abs)
	if err != nil {
		return "", err
	}
	st, err := os.Stat(abs)
	if err != nil {
		return "", err
	}
	if !st.IsDir() {
		return "", errors.New("scope must be a directory")
	}
	return abs, nil
}

func Contains(root, path string) bool {
	rel, err := filepath.Rel(root, path)
	return err == nil && (rel == "." || filepath.IsLocal(rel))
}
func CWD(p model.Scope) string {
	for _, r := range p.Roots {
		if r.ID == p.PrimaryRootID {
			return r.Path
		}
	}
	return ""
}
func Root(p model.Scope, id string) (string, error) {
	for _, r := range p.Roots {
		if r.ID == id {
			return r.Path, nil
		}
	}
	return "", errors.New("unknown scope root")
}

func open(root, path string) (*os.File, error) {
	if path == "" {
		path = "."
	}
	if !filepath.IsLocal(path) {
		return nil, errors.New("path is outside scope")
	}
	r, err := os.OpenRoot(root)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	return r.Open(filepath.FromSlash(path))
}

func List(ctx context.Context, root, path string) ([]model.FileEntry, error) {
	f, err := open(root, path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return listDirectory(ctx, f, path, true)
}

func listDirectory(ctx context.Context, f *os.File, path string, gitStatus bool) ([]model.FileEntry, error) {
	entries, err := f.ReadDir(2000)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, err
	}
	out := []model.FileEntry{}
	for _, e := range entries {
		if e.Name() == ".git" {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if info.Mode()&os.ModeSymlink != 0 {
			continue
		}
		out = append(out, model.FileEntry{Name: e.Name(), Path: filepath.ToSlash(filepath.Join(path, e.Name())), Directory: e.IsDir(), Size: info.Size()})
	}
	if gitStatus {
		markGitIgnored(ctx, f.Name(), out)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Directory != out[j].Directory {
			return out[i].Directory
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return out, nil
}

func markGitIgnored(ctx context.Context, directory string, entries []model.FileEntry) {
	if len(entries) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	var paths strings.Builder
	for _, entry := range entries {
		// Prefix literal names to avoid Git interpreting a leading colon as magic.
		paths.WriteString("./")
		paths.WriteString(entry.Name)
		paths.WriteByte(0)
	}
	// Without --no-index, Git can glob names against the index before applying
	// ignore rules. Check the exact names, then remove tracked files and folders
	// containing tracked files from the ignored set.
	matches, err := device.OutputWithInput(ctx, "git", strings.NewReader(paths.String()),
		"-C", directory, "-c", "core.fsmonitor=false", "check-ignore", "--no-index", "-z", "--stdin")
	if err != nil || len(matches) == 0 {
		return
	}
	tracked, err := git(ctx, directory, "ls-files", "--cached", "--ignored", "--exclude-standard", "-z", "--", ".")
	if err != nil {
		return
	}
	ignored := make(map[string]bool)
	for path := range strings.SplitSeq(string(matches), "\x00") {
		ignored[strings.TrimPrefix(path, "./")] = true
	}
	for path := range strings.SplitSeq(string(tracked), "\x00") {
		name, _, _ := strings.Cut(path, "/")
		delete(ignored, name)
	}
	for i := range entries {
		entries[i].GitIgnored = ignored[entries[i].Name]
	}
}

// Create adds one empty entry without replacing any existing file or directory.
// OpenRoot confines both path traversal and symlink resolution to the scope.
func Create(root, path string, directory bool) (model.FileEntry, error) {
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
	if directory {
		err = r.Mkdir(filepath.FromSlash(path), 0755)
	} else {
		var file *os.File
		file, err = r.OpenFile(filepath.FromSlash(path), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0644)
		if err == nil {
			err = file.Close()
		}
	}
	if err != nil {
		return model.FileEntry{}, err
	}
	return model.FileEntry{Name: filepath.Base(path), Path: path, Directory: directory}, nil
}

func validateEntryPath(path string) error {
	if path == "." || !filepath.IsLocal(path) || strings.Contains(path, "\\") || strings.ContainsRune(path, 0) {
		return fmt.Errorf("%w: expected a relative file or directory path", ErrInvalidFile)
	}
	for _, part := range strings.Split(path, "/") {
		if part == "" || part == "." || part == ".." {
			return fmt.Errorf("%w: invalid path segment", ErrInvalidFile)
		}
	}
	return nil
}

func Read(root, path string) (model.FileContent, error) {
	f, err := open(root, path)
	if err != nil {
		return model.FileContent{}, err
	}
	defer f.Close()
	return readFile(f, path)
}

func readFile(f *os.File, path string) (model.FileContent, error) {
	result := model.FileContent{Path: path}
	st, err := f.Stat()
	if err != nil {
		return result, err
	}
	if !st.Mode().IsRegular() {
		return result, errors.New("only regular files can be previewed")
	}
	b, err := io.ReadAll(io.LimitReader(f, MaxFileBytes+1))
	if err != nil {
		return result, err
	}
	if strings.ContainsRune(string(b), 0) {
		return result, ErrUnsupportedPreview
	}
	result.Truncated = len(b) > MaxFileBytes || st.Size() > int64(len(b))
	if len(b) > MaxFileBytes {
		b = b[:MaxFileBytes]
	}
	if result.Truncated {
		for n := 0; n < 3 && len(b) > 0 && !utf8.Valid(b); n++ {
			b = b[:len(b)-1]
		}
	}
	if !utf8.Valid(b) {
		return result, ErrUnsupportedPreview
	}
	result.Content = string(b)
	if !result.Truncated {
		result.Version = fmt.Sprintf("%x", sha256.Sum256(b))
	}
	return result, nil
}

// CreateText publishes a complete file without replacing an existing entry.
func CreateText(root, path, content string) error {
	if len(content) > MaxFileBytes || !utf8.ValidString(content) || strings.ContainsRune(content, 0) {
		return ErrInvalidFile
	}
	r, err := os.OpenRoot(root)
	if err != nil {
		return err
	}
	defer r.Close()
	return CreateFile(r, path, []byte(content))
}

// CreateFile publishes bytes through a same-directory temporary file.
func CreateFile(root *os.Root, path string, data []byte) error {
	if err := validateEntryPath(path); err != nil {
		return err
	}
	fileWriteMu.Lock()
	defer fileWriteMu.Unlock()
	parent, err := root.OpenRoot(filepath.Dir(filepath.FromSlash(path)))
	if err != nil {
		return err
	}
	defer parent.Close()
	tempName, err := stageFile(parent, data, 0600)
	if err != nil {
		return err
	}
	defer parent.Remove(tempName)
	return renameEntry(parent, tempName, filepath.Base(path))
}

// Write replaces a complete text file. The version is the last content the
// editor read, so stale browser drafts cannot silently overwrite newer content.
func Write(root, path, content, version string) (model.FileContent, error) {
	if !filepath.IsLocal(path) {
		return model.FileContent{}, ErrInvalidFile
	}
	r, err := os.OpenRoot(root)
	if err != nil {
		return model.FileContent{}, err
	}
	defer r.Close()
	parent, err := r.OpenRoot(filepath.Dir(filepath.FromSlash(path)))
	if err != nil {
		return model.FileContent{}, err
	}
	defer parent.Close()
	return writeFileAt(parent, path, content, version)
}

func writeFileAt(parent *os.Root, path, content, version string) (model.FileContent, error) {
	if !filepath.IsLocal(path) || version == "" || len(content) > MaxFileBytes || !utf8.ValidString(content) || strings.ContainsRune(content, 0) {
		return model.FileContent{}, fmt.Errorf("%w: expected complete UTF-8 text up to 2 MiB and a file version", ErrInvalidFile)
	}
	// Serialize the check and replacement across tabs, clients and overlapping roots.
	fileWriteMu.Lock()
	defer fileWriteMu.Unlock()
	name := filepath.Base(path)
	info, err := parent.Lstat(name)
	if err != nil {
		return model.FileContent{}, err
	}
	if !info.Mode().IsRegular() {
		return model.FileContent{}, fmt.Errorf("%w: only regular files can be saved", ErrInvalidFile)
	}
	if info.Mode().Perm()&0222 == 0 {
		return model.FileContent{}, os.ErrPermission
	}
	// Check write access without truncating the original file.
	f, err := parent.OpenFile(name, os.O_RDWR|hostOpenFlags, 0)
	if err != nil {
		return model.FileContent{}, err
	}
	opened, statErr := f.Stat()
	if statErr != nil || !os.SameFile(info, opened) {
		f.Close()
		return model.FileContent{}, ErrFileConflict
	}
	current, err := readFile(f, path)
	f.Close()
	if err != nil {
		return model.FileContent{}, fmt.Errorf("%w: %v", ErrInvalidFile, err)
	}
	if current.Truncated {
		return model.FileContent{}, fmt.Errorf("%w: truncated files are read only", ErrInvalidFile)
	}
	// A response may have been lost after the previous write succeeded.
	if current.Content == content {
		return current, nil
	}
	if current.Version != version {
		return model.FileContent{}, ErrFileConflict
	}
	tempName, err := stageFile(parent, []byte(content), info.Mode().Perm())
	if err != nil {
		return model.FileContent{}, err
	}
	defer parent.Remove(tempName)
	// External tools do not share our lock. Check again after staging the write.
	latestInfo, err := parent.Lstat(name)
	if err != nil || !os.SameFile(info, latestInfo) {
		return model.FileContent{}, ErrFileConflict
	}
	f, err = parent.OpenFile(name, hostOpenFlags, 0)
	if err != nil {
		return model.FileContent{}, err
	}
	latest, err := readFile(f, path)
	f.Close()
	if err != nil || latest.Version != version {
		return model.FileContent{}, ErrFileConflict
	}
	if err = parent.Rename(tempName, name); err != nil {
		return model.FileContent{}, err
	}
	return model.FileContent{Path: path, Content: content, Version: fmt.Sprintf("%x", sha256.Sum256([]byte(content)))}, nil
}

func stageFile(parent *os.Root, data []byte, mode os.FileMode) (string, error) {
	name := ".lever-save-" + rand.Text()
	file, err := parent.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return "", err
	}
	if _, err = file.Write(data); err == nil {
		err = file.Chmod(mode)
	}
	if err == nil {
		err = file.Sync()
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		_ = parent.Remove(name)
		return "", err
	}
	return name, nil
}
