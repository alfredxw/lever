package workspace

import (
	"errors"
	"fmt"
	"io/fs"
	"strconv"
	"strings"

	"lever/internal/model"
)

// CodexTurnDiff indexes the runtime's unified diff without consulting the
// working tree. A file request returns the original bytes of that section.
func CodexTurnDiff(patch, path string) (model.DiffResult, error) {
	result := model.DiffResult{Files: []model.DiffFile{}, Untracked: []string{}}
	var selected string
	for rest := patch; rest != ""; {
		end := len(rest)
		if next := strings.Index(rest, "\ndiff --git "); next >= 0 {
			end = next + 1
		}
		section := rest[:end]
		file, err := codexPatchFile(section)
		if err != nil {
			return result, err
		}
		result.Files = append(result.Files, file)
		if file.Path == path {
			selected = section
		}
		rest = rest[end:]
	}
	if path != "" {
		if selected == "" {
			return result, fmt.Errorf("file is not in this turn diff: %w", fs.ErrNotExist)
		}
		return withPatch(result, selected, path)
	}
	if largeDiff(result.Files) {
		result.SingleFile = true
		return result, nil
	}
	return withPatch(result, patch, "")
}

func codexPatchFile(section string) (model.DiffFile, error) {
	header, body, _ := strings.Cut(section, "\n")
	paths, ok := strings.CutPrefix(strings.TrimSuffix(header, "\r"), "diff --git ")
	if !ok {
		return model.DiffFile{}, errors.New("unrecognized Codex turn diff header")
	}
	oldPath, newPath := "", ""
	file := model.DiffFile{Status: "M"}
	inHunk := false
	for line := range strings.Lines(body) {
		if inHunk {
			switch line[0] {
			case '+':
				file.Additions++
			case '-':
				file.Deletions++
			}
			continue
		}
		line = strings.TrimRight(line, "\r\n")
		switch {
		case strings.HasPrefix(line, "@@ "):
			inHunk = true
		case strings.HasPrefix(line, "--- "):
			oldPath = patchHeaderPath(line[4:], "a/")
		case strings.HasPrefix(line, "+++ "):
			newPath = patchHeaderPath(line[4:], "b/")
		case strings.HasPrefix(line, "rename from "):
			oldPath = patchHeaderPath(line[len("rename from "):], "")
		case strings.HasPrefix(line, "rename to "):
			newPath = patchHeaderPath(line[len("rename to "):], "")
		case strings.HasPrefix(line, "new file mode "):
			file.Status = "A"
		case strings.HasPrefix(line, "deleted file mode "):
			file.Status = "D"
		case strings.HasPrefix(line, "Binary files "), line == "GIT binary patch":
			file.Binary = true
		}
	}
	// Empty files can have just a diff --git line and a mode. Codex writes
	// identical a/ and b/ names there, including unquoted spaces.
	if oldPath == "" && newPath == "" {
		mid := len(paths) / 2
		if len(paths)%2 == 0 || paths[mid] != ' ' {
			return file, errors.New("missing file paths in Codex turn diff")
		}
		oldPath = patchHeaderPath(paths[:mid], "a/")
		newPath = patchHeaderPath(paths[mid+1:], "b/")
	}
	switch {
	case newPath == "/dev/null":
		file.Path, file.Status = oldPath, "D"
	case oldPath == "/dev/null":
		file.Path, file.Status = newPath, "A"
	default:
		file.Path = newPath
		if oldPath != newPath {
			file.Status = "R"
		}
	}
	if file.Path == "" {
		return file, errors.New("missing file path in Codex turn diff")
	}
	return file, nil
}

func patchHeaderPath(value, prefix string) string {
	if unquoted, err := strconv.Unquote(value); err == nil {
		value = unquoted
	}
	return strings.TrimPrefix(value, prefix)
}
