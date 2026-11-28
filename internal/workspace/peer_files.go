package workspace

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"lever/internal/model"
)

// Resolve once and operate relative to directory handles. A path component
// replaced while opening must still name the same directory.
func peerDirectory(root, relative, dataDir string, write bool) (*os.Root, error) {
	if !filepath.IsAbs(root) || !filepath.IsLocal(relative) || strings.Contains(relative, "\\") {
		return nil, os.ErrPermission
	}
	canonical, err := filepath.EvalSymlinks(root)
	if err != nil {
		return nil, err
	}
	path := filepath.Join(canonical, relative)
	if !Contains(canonical, path) || !peerPathAllowed(path, dataDir, write) {
		return nil, os.ErrPermission
	}
	volume := filepath.VolumeName(path) + string(filepath.Separator)
	dir, err := os.OpenRoot(volume)
	if err != nil {
		return nil, err
	}
	parts := strings.Split(strings.TrimPrefix(path, volume), string(filepath.Separator))
	for _, name := range parts {
		if name == "" {
			continue
		}
		info, err := dir.Lstat(name)
		if err != nil {
			dir.Close()
			return nil, err
		}
		if !info.IsDir() {
			dir.Close()
			return nil, os.ErrPermission
		}
		child, err := dir.OpenRoot(name)
		dir.Close()
		if err != nil {
			return nil, err
		}
		actual, err := child.Stat(".")
		if err != nil || !os.SameFile(info, actual) {
			child.Close()
			return nil, os.ErrPermission
		}
		dir = child
	}
	return dir, nil
}

var shortNameAlias = regexp.MustCompile(`~[0-9]+(?:\.|$)`)

func peerPathAllowed(path, dataDir string, write bool) bool {
	path = strings.ToLower(filepath.ToSlash(filepath.Clean(path)))
	if dataDir != "" && Contains(strings.ToLower(filepath.ToSlash(dataDir)), path) {
		return false
	}
	parts := strings.Split(strings.TrimPrefix(path, strings.ToLower(filepath.VolumeName(path))), "/")
	for i, part := range parts {
		if shortNameAlias.MatchString(part) || strings.Contains(part, ":") || strings.HasSuffix(part, ".") || strings.HasSuffix(part, " ") {
			return false
		}
		switch part {
		case ".ssh", ".gnupg", ".aws", ".configstore", ".netrc", ".npmrc", ".git-credentials", ".password-store", ".terraform.d", ".vault-token", ".azure", ".kube", ".docker", ".git", ".lever", "keychains", "credentials", "credentials.json", "application_default_credentials.json", "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa", "proc", "sys", "dev":
			return false
		case "gcloud", "gh", "op":
			if i > 0 && parts[i-1] == ".config" {
				return false
			}
		}
		switch filepath.Ext(part) {
		case ".key", ".pem", ".p12", ".p8", ".pfx":
			return false
		}
		if write {
			switch part {
			case ".bashrc", ".bash_profile", ".bash_login", ".zshrc", ".zshenv", ".zprofile", ".zlogin", ".profile", ".gitconfig", "launchagents", "launchdaemons", "autostart", "startup", "systemd", "powershell", "crontab", "cron.d", "authorized_keys":
				return false
			}
		}
	}
	return true
}

func PeerList(ctx context.Context, root, path, dataDir string) ([]model.FileEntry, error) {
	if path == "" {
		path = "."
	}
	dir, err := peerDirectory(root, path, dataDir, false)
	if err != nil {
		return nil, err
	}
	defer dir.Close()
	f, err := dir.Open(".")
	if err != nil {
		return nil, err
	}
	defer f.Close()
	rows, err := listDirectory(ctx, f, path, false)
	if err != nil {
		return nil, err
	}
	out := rows[:0]
	for _, row := range rows {
		if !peerPathAllowed(filepath.Join(dir.Name(), row.Name), dataDir, false) {
			continue
		}
		if !row.Directory {
			f, _, err := openPeerFile(dir, row.Name)
			if err != nil {
				continue
			}
			f.Close()
		}
		out = append(out, row)
	}
	return out, nil
}
func OpenPeerAsset(root, path, dataDir string) (*os.File, string, error) {
	parent, err := guardedParent(root, path, dataDir, false)
	if err != nil {
		return nil, "", err
	}
	defer parent.Close()
	file, _, err := openPeerFile(parent, filepath.Base(path))
	if err != nil {
		return nil, "", err
	}
	return assetFromFile(file, path)
}

func PeerFile(root, path, dataDir string, write *model.FileWrite) (model.FileContent, error) {
	var empty model.FileContent
	parent, err := guardedParent(root, path, dataDir, write != nil)
	if err != nil {
		return empty, err
	}
	defer parent.Close()
	name := filepath.Base(path)
	f, _, err := openPeerFile(parent, name)
	if err != nil {
		return empty, err
	}
	defer f.Close()
	if write != nil {
		if write.RootPath != root {
			return empty, ErrFileConflict
		}
		return writeFileAt(parent, path, write.Content, write.Version)
	}
	return readFile(f, path)
}

func guardedParent(root, path, dataDir string, write bool) (*os.Root, error) {
	if validateEntryPath(path) != nil {
		return nil, os.ErrPermission
	}
	parent, err := peerDirectory(root, filepath.Dir(path), dataDir, write)
	if err == nil && !peerPathAllowed(filepath.Join(parent.Name(), filepath.Base(path)), dataDir, write) {
		parent.Close()
		return nil, os.ErrPermission
	}
	return parent, err
}

func PeerCreate(root, path, dataDir string, directory bool) (model.FileEntry, error) {
	entry := model.FileEntry{Name: filepath.Base(path), Path: path, Directory: directory}
	parent, err := guardedParent(root, path, dataDir, true)
	if err != nil {
		return entry, err
	}
	defer parent.Close()
	if directory {
		err = parent.Mkdir(entry.Name, 0755)
	} else {
		var f *os.File
		f, err = parent.OpenFile(entry.Name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0644)
		if err == nil {
			err = f.Close()
		}
	}
	return entry, err
}

func PeerChange(root, path, dataDir, op, destination string) (model.FileEntry, error) {
	fileWriteMu.Lock()
	defer fileWriteMu.Unlock()
	var entry model.FileEntry
	parent, err := guardedParent(root, path, dataDir, true)
	if err != nil {
		return entry, err
	}
	defer parent.Close()
	name := filepath.Base(path)
	info, err := parent.Lstat(name)
	if err != nil {
		return entry, err
	}
	var src *os.File
	if !info.IsDir() {
		src, info, err = openPeerFile(parent, name)
		if err != nil {
			return entry, err
		}
		defer src.Close()
	}
	if op == "delete" {
		return entry, parent.Remove(name)
	}
	if op != "move" && op != "duplicate" && op != "copy" {
		return entry, ErrInvalidFile
	}
	if op == "duplicate" {
		ext := filepath.Ext(path)
		if info.IsDir() || ext == name {
			ext = ""
		}
		base := strings.TrimSuffix(path, ext)
		for i := 1; ; i++ {
			suffix := " copy"
			if i > 1 {
				suffix = fmt.Sprintf(" copy %d", i)
			}
			destination = base + suffix + ext
			_, err = parent.Lstat(filepath.Base(destination))
			if os.IsNotExist(err) {
				break
			}
			if err != nil {
				return entry, err
			}
		}
	}
	dest, err := guardedParent(root, destination, dataDir, true)
	if err != nil {
		return entry, err
	}
	defer dest.Close()
	target := filepath.Base(destination)
	entry = model.FileEntry{Name: target, Path: destination, Directory: info.IsDir(), Size: info.Size()}
	if info.IsDir() { // A recursive operation could move protected descendants out of their original boundary.
		d, err := parent.OpenRoot(name)
		if err != nil {
			return entry, err
		}
		defer d.Close()
		f, err := d.Open(".")
		if err != nil {
			return entry, err
		}
		defer f.Close()
		if _, err = f.Readdirnames(1); err != io.EOF {
			return entry, fmt.Errorf("%w: only empty directories can be moved or copied remotely", ErrInvalidFile)
		}
	}
	if op == "move" {
		from, err := parent.Open(".")
		if err != nil {
			return entry, err
		}
		defer from.Close()
		to, err := dest.Open(".")
		if err != nil {
			return entry, err
		}
		defer to.Close()
		return entry, renameEntryAt(from, to, name, target)
	}
	if info.IsDir() {
		return entry, dest.Mkdir(target, 0755)
	}
	out, err := dest.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, info.Mode().Perm()&0777)
	if err != nil {
		return entry, err
	}
	_, err = io.Copy(out, src)
	closeErr := out.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		_ = dest.Remove(target)
	}
	return entry, err
}

// PeerDiff checks the requested path before Git reads a patch. Aggregated
// results contain statistics only; the client fetches individual visible files.
func PeerDiff(ctx context.Context, root, dataDir, mode, base, head string, opts DiffOptions) (model.DiffResult, error) {
	dir, err := peerDirectory(root, ".", dataDir, false)
	if err != nil {
		return model.DiffResult{}, err
	}
	defer dir.Close()
	root = dir.Name()
	opts.allowed = func(path string) bool { return PeerAllowsPath(root, path, dataDir) }
	if opts.Path != "" && !opts.allowed(opts.Path) {
		return model.DiffResult{}, os.ErrPermission
	}
	if mode != "" && mode != "working" {
		return Diff(ctx, root, mode, base, head, opts)
	}
	repo, rel, err := repository(ctx, root)
	if err != nil {
		return model.DiffResult{}, err
	}
	before, err := revision(ctx, root, "HEAD")
	if err != nil {
		before, err = emptyTree(ctx, root)
	}
	if err != nil {
		return model.DiffResult{}, err
	}
	untracked, err := gitReadOnly(ctx, root, "ls-files", "--others", "--exclude-standard", "-z", "--", ".")
	if err != nil {
		return model.DiffResult{}, err
	}
	var extra []model.DiffFile
	var current *model.DiffFile
	for _, path := range strings.Split(string(untracked), "\x00") {
		if path == "" || !opts.allowed(path) {
			continue
		}
		extra = append(extra, model.DiffFile{Path: path, Status: "A"})
		if path == opts.Path {
			f := extra[len(extra)-1]
			current = &f
		}
	}
	selected := opts.Path
	if current != nil {
		opts.Path = ""
	}
	result, err := diffAt(ctx, repo, rel, []string{before}, opts)
	if err != nil {
		return result, err
	}
	result.Files = append(result.Files, extra...)
	if current == nil {
		return result, nil
	}
	content, err := PeerFile(root, selected, dataDir, nil)
	if errors.Is(err, ErrUnsupportedPreview) {
		for i := range result.Files {
			if result.Files[i].Path == selected {
				result.Files[i].Binary = true
			}
		}
		return result, nil
	}
	if err != nil {
		return result, err
	}
	if content.Truncated {
		return result, fmt.Errorf("%w: file exceeds text preview limit", ErrInvalidFile)
	}
	lines := strings.SplitAfter(content.Content, "\n")
	var patch strings.Builder
	fmt.Fprintf(&patch, "diff --git %q %q\nnew file mode 100644\n--- /dev/null\n+++ %q\n", "a/"+selected, "b/"+selected, "b/"+selected)
	if content.Content != "" {
		count := len(lines)
		if lines[count-1] == "" {
			count--
		}
		fmt.Fprintf(&patch, "@@ -0,0 +1,%d @@\n", count)
		for _, line := range lines[:count] {
			patch.WriteByte('+')
			patch.WriteString(line)
		}
		if !strings.HasSuffix(content.Content, "\n") {
			patch.WriteString("\n\\ No newline at end of file\n")
		}
	}
	result.Patch = patch.String()
	return result, nil
}

func PeerAllowsRoot(root, dataDir string) bool {
	dir, err := peerDirectory(root, ".", dataDir, false)
	if err != nil {
		return false
	}
	dir.Close()
	return true
}

// PeerAllowsPath applies the same metadata and link checks to Git file names as to workspace reads.
func PeerAllowsPath(root, path, dataDir string) bool {
	if validateEntryPath(path) != nil || !peerPathAllowed(filepath.Join(root, path), dataDir, false) {
		return false
	}
	parent, err := guardedParent(root, path, dataDir, false)
	if os.IsNotExist(err) {
		return true
	}
	if err != nil {
		return false
	}
	defer parent.Close()
	name := filepath.Base(path)
	f, _, err := openPeerFile(parent, name)
	if os.IsNotExist(err) {
		return true
	} // A deleted tracked file has no live inode.
	if err != nil {
		return false
	}
	f.Close()
	return true
}

func openPeerFile(parent *os.Root, name string) (*os.File, os.FileInfo, error) {
	info, err := parent.Lstat(name)
	if err != nil {
		return nil, nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, nil, os.ErrPermission
	}
	f, err := parent.OpenFile(name, hostOpenFlags, 0)
	if err != nil {
		return nil, nil, err
	}
	opened, err := f.Stat()
	if err != nil || !os.SameFile(info, opened) || !peerSingleLink(f, opened) {
		f.Close()
		return nil, nil, os.ErrPermission
	}
	return f, opened, nil
}
