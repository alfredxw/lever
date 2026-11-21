package plugin

import (
	"archive/tar"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode"

	"lever/internal/device"
	"lever/internal/model"
)

var gitObjectID = regexp.MustCompile("^(?:[0-9a-f]{40}|[0-9a-f]{64})$")
var scpRemote = regexp.MustCompile("^([a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+):(.+)$")

// Git accepts many transports and revision expressions. The install form
// accepts an SSH/HTTPS repository, an exact branch/tag/commit and a package path.
func GitSource(address, ref, subdir string) (model.PluginGitSource, error) {
	address, ref, subdir = strings.TrimSpace(address), strings.TrimSpace(ref), strings.TrimSpace(subdir)
	if m := scpRemote.FindStringSubmatch(address); m != nil {
		// Keep SCP syntax: its path is relative to the SSH account's home.
		if strings.HasPrefix(m[2], "-") || strings.ContainsAny(m[2], "?#") {
			return model.PluginGitSource{}, errors.New("Invalid SSH repository path")
		}
	} else {
		u, err := url.Parse(address)
		if err != nil || (u.Scheme != "https" && u.Scheme != "ssh") || u.Hostname() == "" || strings.HasPrefix(u.Hostname(), "-") || strings.Trim(u.Path, "/") == "" || u.RawQuery != "" || u.Fragment != "" {
			return model.PluginGitSource{}, errors.New("Enter an HTTPS or SSH Git repository URL")
		}
		if _, password := u.User.Password(); password || (u.Scheme == "https" && u.User != nil) {
			return model.PluginGitSource{}, errors.New("Use the host's Git credentials instead of credentials in the repository URL")
		}
	}
	if len(address) > 2048 || strings.IndexFunc(address, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }) >= 0 {
		return model.PluginGitSource{}, errors.New("Invalid Git repository URL")
	}
	if ref != "" && (len(ref) > 255 || strings.HasPrefix(ref, "-") || strings.ContainsAny(ref, " ~^:?*[\\") || strings.Contains(ref, "..") || strings.Contains(ref, "@{") || strings.IndexFunc(ref, unicode.IsControl) >= 0) {
		return model.PluginGitSource{}, errors.New("Enter an exact branch, tag or commit")
	}
	if subdir == "." {
		subdir = ""
	}
	if subdir != "" && !packagePath(subdir) {
		return model.PluginGitSource{}, errors.New("Select a directory within the repository")
	}
	return model.PluginGitSource{URL: address, Ref: ref, Path: subdir}, nil
}

func packagePath(name string) bool {
	if !fs.ValidPath(name) || name == "." || len(name) > 4096 || strings.ContainsAny(name, "\\:") || strings.IndexFunc(name, unicode.IsControl) >= 0 {
		return false
	}
	for part := range strings.SplitSeq(name, "/") {
		if strings.EqualFold(part, ".git") {
			return false
		}
	}
	_, err := filepath.Localize(name)
	return err == nil
}

func gitCommand(dir string, args ...string) (*exec.Cmd, error) {
	path, err := device.Executable("git")
	if err != nil {
		return nil, err
	}
	options := []string{"-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "protocol.ssh.allow=always", "-c", "core.hooksPath=" + os.DevNull}
	cmd := device.Command(path, append(options, args...)...)
	cmd.Dir = dir
	// Lever can itself be started by a Git hook. Never inherit the caller's
	// repository, index or object database when preparing a remote package.
	cmd.Env = slices.DeleteFunc(cmd.Env, func(value string) bool {
		key, _, _ := strings.Cut(value, "=")
		switch strings.ToUpper(key) {
		case "GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_SHALLOW_FILE", "GIT_QUARANTINE_PATH":
			return true
		}
		return false
	})
	cmd.Env = append(cmd.Env, "GIT_ALLOW_PROTOCOL=https:ssh", "GIT_TERMINAL_PROMPT=0", "GCM_INTERACTIVE=Never", "SSH_ASKPASS_REQUIRE=never")
	if os.Getenv("GIT_SSH_COMMAND") == "" {
		cmd.Env = append(cmd.Env, "GIT_SSH_COMMAND=ssh -o BatchMode=yes -o ConnectTimeout=15")
	}
	return cmd, nil
}

func gitOutput(ctx context.Context, dir string, args ...string) (string, error) {
	cmd, err := gitCommand(dir, args...)
	if err != nil {
		return "", err
	}
	out, err := device.OutputCommand(ctx, cmd)
	return strings.TrimSpace(string(out)), err
}

// ResolveGit records the default branch by name. Tags (including annotated
// tags) and explicit commits are pinned; subsequent checks only follow branches.
func ResolveGit(ctx context.Context, source model.PluginGitSource) (model.PluginGitSource, string, error) {
	if gitObjectID.MatchString(strings.ToLower(source.Ref)) && source.Kind != "branch" && source.Kind != "tag" {
		source.Kind, source.Ref = "commit", strings.ToLower(source.Ref)
		return source, source.Ref, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	args := []string{"ls-remote", "--symref", "--", source.URL}
	if source.Ref == "" {
		args = append(args, "HEAD")
	} else {
		args = append(args, "refs/heads/"+source.Ref, "refs/tags/"+source.Ref, "refs/tags/"+source.Ref+"^{}")
	}
	out, err := gitOutput(ctx, os.TempDir(), args...)
	if err != nil {
		return source, "", err
	}
	refs := map[string]string{}
	for line := range strings.SplitSeq(out, "\n") {
		value, name, ok := strings.Cut(line, "\t")
		if !ok {
			continue
		}
		if name == "HEAD" && strings.HasPrefix(value, "ref: refs/heads/") && source.Ref == "" {
			source.Ref, source.Kind = strings.TrimPrefix(value, "ref: refs/heads/"), "branch"
		}
		if gitObjectID.MatchString(value) {
			refs[name] = value
		}
	}
	if source.Ref != "" && refs["HEAD"] != "" {
		return source, refs["HEAD"], nil
	}
	branch, tag := refs["refs/heads/"+source.Ref], refs["refs/tags/"+source.Ref]
	if source.Kind == "branch" {
		tag = ""
	}
	if source.Kind == "tag" {
		branch = ""
	}
	if branch != "" && tag != "" {
		return source, "", errors.New("This name identifies both a branch and a tag. Select a commit instead")
	}
	if branch != "" {
		source.Kind = "branch"
		return source, branch, nil
	}
	if tag != "" {
		source.Kind = "tag"
		if peeled := refs["refs/tags/"+source.Ref+"^{}"]; peeled != "" {
			tag = peeled
		}
		return source, tag, nil
	}
	return source, "", errors.New("Git branch, tag or default branch was not found")
}

// GitTree fetches the exact reviewed revision into a disposable bare repository.
// A check reads just the tree ID. Only a preview exports files, without running
// checkout filters, hooks, submodules or build scripts.
func GitTree(ctx context.Context, source model.PluginGitSource, commit, destination string) (string, error) {
	if !gitObjectID.MatchString(commit) {
		return "", errors.New("Invalid Git commit ID")
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	repo, err := os.MkdirTemp("", "lever-plugin-git-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(repo)
	init := []string{"init", "--quiet", "--bare", "--template="}
	if len(commit) == 64 {
		init = append(init, "--object-format=sha256")
	}
	for _, args := range [][]string{init, {"remote", "add", "origin", source.URL}, {"fetch", "--quiet", "--no-tags", "--depth=1", "--filter=blob:none", "origin", commit}} {
		if _, err := gitOutput(ctx, repo, args...); err != nil {
			return "", err
		}
	}
	if kind, err := gitOutput(ctx, repo, "cat-file", "-t", commit); err != nil || kind != "commit" {
		return "", errors.New("Select a Git commit or a tag pointing to a commit")
	}
	tree, err := gitOutput(ctx, repo, "rev-parse", "--verify", commit+":"+source.Path)
	if err != nil || !gitObjectID.MatchString(tree) {
		return "", errors.New("Plugin directory was not found in the selected commit")
	}
	if kind, err := gitOutput(ctx, repo, "cat-file", "-t", tree); err != nil || kind != "tree" {
		return "", errors.New("Plugin path must be a directory")
	}
	if destination != "" {
		cmd, err := gitCommand(repo, "archive", "--format=tar", tree)
		if err != nil {
			return "", err
		}
		reader, writer := io.Pipe()
		done := make(chan error, 1)
		go func() {
			err := device.WriteCommandOutput(ctx, cmd, writer)
			writer.CloseWithError(err)
			done <- err
		}()
		err = unpackPlugin(reader, destination)
		if err == nil {
			// Consume the TAR padding before closing the pipe to the producer.
			_, err = io.Copy(io.Discard, reader)
		}
		reader.CloseWithError(err)
		if gitErr := <-done; err == nil {
			err = gitErr
		}
		if err != nil {
			return "", err
		}
	}
	return tree, nil
}

func unpackPlugin(input io.Reader, dest string) error {
	const maxBytes = 128 << 20
	tr := tar.NewReader(input)
	var total int64
	for count := 0; ; count++ {
		entry, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		name := strings.TrimSuffix(entry.Name, "/")
		if !packagePath(name) || count >= 8192 || entry.Size > maxBytes-total {
			return errors.New("Invalid plugin path or package size limit exceeded")
		}
		target := filepath.Join(dest, filepath.FromSlash(name))
		switch entry.Typeflag {
		case tar.TypeDir:
			err = os.MkdirAll(target, 0700)
		case tar.TypeReg:
			total += entry.Size
			if err = os.MkdirAll(filepath.Dir(target), 0700); err != nil {
				return err
			}
			mode := fs.FileMode(0600)
			if entry.Mode&0111 != 0 {
				mode = 0700
			}
			file, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
			if err != nil {
				return err
			}
			_, copyErr := io.CopyN(file, tr, entry.Size)
			if err := errors.Join(copyErr, file.Close()); err != nil {
				return err
			}
		default:
			return fmt.Errorf("Unsupported plugin file %q: packages must contain regular files and directories", name)
		}
		if err != nil {
			return err
		}
	}
}
