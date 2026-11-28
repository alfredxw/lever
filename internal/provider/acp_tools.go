package provider

import (
	"cmp"
	"fmt"
	"path/filepath"
	"strings"

	acp "github.com/coder/acp-go-sdk"
	"lever/internal/model"
)

type acpToolState struct {
	ID        string
	Title     string
	Kind      acp.ToolKind
	Status    acp.ToolCallStatus
	Content   []acp.ToolCallContent
	Locations []acp.ToolCallLocation
	RawInput  any
	RawOutput any
	Meta      map[string]any
}

func (c *acpRuntime) mergeToolCall(tool *acp.SessionUpdateToolCall) *acpToolState {
	id := string(tool.ToolCallId)
	state := c.tools[id]
	if state == nil {
		state = &acpToolState{ID: id}
		c.tools[id] = state
	}
	if tool.Title != "" {
		state.Title = tool.Title
	}
	if tool.Kind != "" {
		state.Kind = tool.Kind
	}
	if tool.Status != "" {
		state.Status = tool.Status
	}
	if tool.Content != nil {
		state.Content = tool.Content
	}
	if tool.Locations != nil {
		state.Locations = tool.Locations
	}
	if tool.RawInput != nil {
		state.RawInput = tool.RawInput
	}
	if tool.RawOutput != nil {
		state.RawOutput = tool.RawOutput
	}
	if tool.Meta != nil {
		state.Meta = tool.Meta
	}
	return state
}

func (c *acpRuntime) mergeToolCallUpdate(tool *acp.SessionToolCallUpdate) *acpToolState {
	id := string(tool.ToolCallId)
	state := c.tools[id]
	if state == nil {
		state = &acpToolState{ID: id}
		c.tools[id] = state
	}
	if tool.Title != nil && *tool.Title != "" {
		state.Title = *tool.Title
	}
	if tool.Kind != nil && *tool.Kind != "" {
		state.Kind = *tool.Kind
	}
	if tool.Status != nil {
		state.Status = *tool.Status
	}
	if tool.Content != nil {
		state.Content = tool.Content
	}
	if tool.Locations != nil {
		state.Locations = tool.Locations
	}
	if tool.RawInput != nil {
		state.RawInput = tool.RawInput
	}
	if tool.RawOutput != nil {
		state.RawOutput = tool.RawOutput
	}
	if tool.Meta != nil {
		state.Meta = tool.Meta
	}
	return state
}

func isAntigravitySubagentCall(state *acpToolState) bool {
	if state.Kind != "" && state.Kind != acp.ToolKindOther {
		return false
	}
	switch strings.TrimSpace(state.Title) {
	case "Running start_subagent", "Run start_subagent?", "Running invoke_subagent", "Run invoke_subagent?", "Run invoke_subagent":
	default:
		return false
	}
	if state.Meta != nil && state.Meta["is_mcp_tool_call"] == true {
		return false
	}
	return true
}

func isAntigravityImageGeneratorType(raw string) bool {
	s := strings.ToLower(strings.TrimSpace(raw))
	return s == "image-generator" || s == "image_generator" || s == "imagegenerator"
}

func antigravitySubagentTask(state *acpToolState) (title, prompt string, imageGenerator bool) {
	input := obj(state.RawInput)
	type launch struct{ role, prompt string }
	var launches []launch
	if batch := arr(input["Subagents"]); len(batch) > 0 {
		for _, entry := range batch {
			spec := obj(entry)
			typeName := cmp.Or(str(spec["TypeName"]), str(spec["typeName"]), str(spec["type_name"]))
			isImg := isAntigravityImageGeneratorType(typeName)
			if isImg {
				imageGenerator = true
			}
			role := strings.TrimSpace(cmp.Or(str(spec["Role"]), str(spec["role"])))
			if role == "" && isImg {
				role = "Image generator"
			}
			p := strings.TrimSpace(cmp.Or(str(spec["Prompt"]), str(spec["prompt"])))
			if role != "" || p != "" {
				launches = append(launches, launch{role: role, prompt: p})
			}
		}
	} else {
		typeName := cmp.Or(str(input["TypeName"]), str(input["typeName"]), str(input["type_name"]))
		isImg := isAntigravityImageGeneratorType(typeName)
		if isImg {
			imageGenerator = true
		}
		role := strings.TrimSpace(cmp.Or(str(input["Role"]), str(input["role"])))
		if role == "" && isImg {
			role = "Image generator"
		}
		p := strings.TrimSpace(cmp.Or(str(input["Prompt"]), str(input["prompt"])))
		if role != "" || p != "" {
			launches = append(launches, launch{role: role, prompt: p})
		}
	}
	switch len(launches) {
	case 0:
		return "", "", imageGenerator
	case 1:
		return launches[0].role, launches[0].prompt, imageGenerator
	default:
		roles := make([]string, 0, len(launches))
		prompts := make([]string, 0, len(launches))
		for _, l := range launches {
			if l.role != "" {
				roles = append(roles, l.role)
			}
			if l.role != "" && l.prompt != "" {
				prompts = append(prompts, l.role+"\n"+l.prompt)
			} else if text := cmp.Or(l.prompt, l.role); text != "" {
				prompts = append(prompts, text)
			}
		}
		return strings.Join(roles, ", "), strings.Join(prompts, "\n\n"), imageGenerator
	}
}

func (c *acpRuntime) emitAntigravitySubagent(state *acpToolState) error {
	agent := c.subagents[state.ID]
	if agent == nil {
		agent = newSubagent(state.ID)
		c.subagents[state.ID] = agent
	}
	title, prompt, imageGenerator := antigravitySubagentTask(state)
	if imageGenerator {
		agent.imageGenerator = true
	}
	agent.task(title, prompt)
	output, imgs := acpToolOutput(c, state, c.cwd)
	if len(imgs) > 0 {
		agent.addImages(imgs)
	}
	switch state.Status {
	case acp.ToolCallStatusCompleted, acp.ToolCallStatusFailed:
		if state.Status == acp.ToolCallStatusCompleted && c.background != nil && c.background.childProbe != nil && acpNormalizedToolName(state.Title) == "invoke_subagent" &&
			(c.background.childCalls[state.ID] > 0 || antigravityLaunchReceipt(state, output)) {
			// The completed call acknowledges the launch. The child's actual
			// report is delivered separately to the parent's native session.
			c.background.childCalls[state.ID] = max(1, len(arr(obj(state.RawInput)["Subagents"])))
			break
		}
		if c.background != nil {
			delete(c.background.childCalls, state.ID)
			delete(c.background.childStates, state.ID)
		}
		if state.Status == acp.ToolCallStatusCompleted {
			if reportImgs := extractExistingImagePaths(output, c.cwd); len(reportImgs) > 0 {
				agent.addImages(reportImgs)
			}
			if agent.imageGenerator && len(agent.item.ImageFiles) > 0 {
				c.recordGeneratedImages(state.ID, agent.item.ImageFiles)
			}
		}
		agent.finish(acpToolStatus(state.Status), output)
	default:
		if output != "" {
			agent.detail.Progress = clip(output)
		}
	}
	return agent.publish(c.sink)
}

// Some versions return the native creation receipt as text or a structured
// result. Others acknowledge the launch with an empty tool_call_update.
func antigravityLaunchReceipt(tool *acpToolState, output string) bool {
	return output == "" || str(obj(tool.RawOutput)["conversationId"]) != "" || strings.Contains(output, "Created the following subagent:\n{")
}

func (c *acpRuntime) normalizeToolItem(state *acpToolState) model.Item {
	item := normalizeACPToolItemWith(c, state, c.cwd)
	if item.ToolAction == model.ToolActionImage && item.Status == "completed" && len(item.ImageFiles) > 0 {
		c.recordGeneratedImages(state.ID, item.ImageFiles)
	}
	return item
}

func normalizeACPToolItem(state *acpToolState, cwd string) model.Item {
	return normalizeACPToolItemWith(nil, state, cwd)
}

func normalizeACPToolItemWith(c *acpRuntime, state *acpToolState, cwd string) model.Item {
	input := obj(state.RawInput)
	output := obj(state.RawOutput)
	command := strings.TrimSpace(cmp.Or(
		str(input["CommandLine"]),
		str(input["command_line"]),
		str(input["commandLine"]),
		str(input["command"]),
		str(output["commandLine"]),
		str(output["command_line"]),
	))
	action := acpToolAction(state.Kind)
	if action == "" {
		action = inferACPToolAction(state.Title, command)
	}
	title := acpToolTitle(state, action, command, input, cwd)
	text, images := acpToolDetail(c, state, command, cwd)
	if action == model.ToolActionRead && state.Status == acp.ToolCallStatusCompleted {
		if rawPath := acpToolRawPath(state, input); rawPath != "" {
			if imgPath := normalizeLocalImagePath(rawPath, cwd); imgPath != "" {
				images = appendUniqueImageFile(images, model.ImageFile{Path: imgPath, Name: filepath.Base(imgPath)})
			}
		}
	}
	item := model.Item{
		ID:         "tool-" + state.ID,
		Kind:       "tool",
		Title:      title,
		ToolAction: action,
		Status:     acpToolStatus(state.Status),
		Text:       clip(text),
		ImageFiles: images,
	}
	if code, ok := acpToolExitCode(output); ok {
		item.ExitCode = &code
	}
	return item
}

func inferACPToolAction(title, command string) model.ToolAction {
	if command != "" {
		return model.ToolActionCommand
	}
	name := acpNormalizedToolName(title)
	switch name {
	case "run_command", "bash", "shell", "execute_command", "command_status":
		return model.ToolActionCommand
	case "view_file", "client_view_file", "read_file", "view_file_outline", "view_code_item", "view_image":
		return model.ToolActionRead
	case "list_dir", "ls":
		return model.ToolActionList
	case "grep_search", "find_by_name", "search_web", "web_search", "read_url_content", "search_files", "glob", "grep":
		return model.ToolActionSearch
	case "replace_file_content", "multi_replace_file_content", "write_to_file", "edit_file", "client_edit_file", "write_file":
		return model.ToolActionEdit
	case "generate_image", "generate image", "image_generation", "image generation", "image_gen", "imagegen", "create_image", "edit_image", "experimental_image_generate":
		return model.ToolActionImage
	default:
		return ""
	}
}

func acpNormalizedToolName(title string) string {
	s := strings.TrimSpace(strings.ToLower(title))
	s = strings.TrimSuffix(s, "?")
	for _, prefix := range []string{"running ", "run "} {
		if rest, ok := strings.CutPrefix(s, prefix); ok {
			s = strings.TrimSpace(rest)
			break
		}
	}
	return s
}

func isGenericACPToolTitle(title string, action model.ToolAction) bool {
	s := strings.TrimSpace(title)
	if s == "" {
		return true
	}
	name := acpNormalizedToolName(s)
	switch name {
	case "run_command", "bash", "shell", "execute_command", "command", "command_status",
		"view_file", "client_view_file", "read_file", "read", "read file", "view_file_outline", "view_code_item", "view_image",
		"list_dir", "ls", "list files", "list directory",
		"grep_search", "find_by_name", "search_web", "web_search", "search", "web search", "grep", "glob", "find", "read_url_content",
		"replace_file_content", "multi_replace_file_content", "write_to_file", "edit_file", "client_edit_file", "write_file", "edit", "write", "file changes",
		"generate_image", "generate image", "image_generation", "image generation", "image_gen", "imagegen", "create_image", "edit_image", "experimental_image_generate",
		"tool call":
		return true
	}
	if action == model.ToolActionCommand && strings.HasPrefix(strings.ToLower(s), "running ") && !strings.Contains(name, " ") {
		return true
	}
	return false
}

func acpToolTitle(state *acpToolState, action model.ToolAction, command string, input object, cwd string) string {
	if action == model.ToolActionCommand && command != "" {
		return command
	}
	if !isGenericACPToolTitle(state.Title, action) {
		return strings.TrimSpace(state.Title)
	}
	switch action {
	case model.ToolActionImage:
		return "Generate image"
	case model.ToolActionRead:
		if target := acpToolPath(state, input, cwd); target != "" {
			return target
		}
	case model.ToolActionEdit:
		if target := acpToolDiffPath(state, cwd); target != "" {
			return target
		}
		if target := acpToolPath(state, input, cwd); target != "" {
			return target
		}
	case model.ToolActionList:
		if target := acpDisplayPath(cmp.Or(
			str(input["DirectoryPath"]),
			str(input["directory_path"]),
			str(input["SearchPath"]),
			str(input["path"]),
			str(input["Path"]),
		), cwd); target != "" {
			return target
		}
	case model.ToolActionSearch:
		if query := strings.TrimSpace(cmp.Or(
			str(input["Query"]),
			str(input["query"]),
			str(input["Pattern"]),
			str(input["pattern"]),
			str(input["Url"]),
			str(input["url"]),
		)); query != "" {
			return query
		}
		if target := acpToolPath(state, input, cwd); target != "" {
			return target
		}
	}
	return strings.TrimSpace(state.Title)
}

func acpToolDiffPath(state *acpToolState, cwd string) string {
	var paths []string
	seen := map[string]bool{}
	for _, entry := range state.Content {
		if entry.Diff != nil && entry.Diff.Path != "" {
			p := acpDisplayPath(entry.Diff.Path, cwd)
			if p != "" && !seen[p] {
				seen[p] = true
				paths = append(paths, p)
			}
		}
	}
	switch len(paths) {
	case 0:
		return ""
	case 1:
		return paths[0]
	default:
		return fmt.Sprintf("%s +%d", paths[0], len(paths)-1)
	}
}

func acpToolRawPath(state *acpToolState, input object) string {
	for _, loc := range state.Locations {
		if loc.Path != "" {
			return loc.Path
		}
	}
	return cmp.Or(
		str(input["AbsolutePath"]),
		str(input["absolute_path"]),
		str(input["TargetFile"]),
		str(input["target_file"]),
		str(input["file_path"]),
		str(input["filePath"]),
		str(input["Path"]),
		str(input["path"]),
		str(input["SearchPath"]),
		str(input["DirectoryPath"]),
	)
}

func acpToolPath(state *acpToolState, input object, cwd string) string {
	return acpDisplayPath(acpToolRawPath(state, input), cwd)
}

func acpDisplayPath(raw, cwd string) string {
	p := strings.TrimSpace(raw)
	if p == "" {
		return ""
	}
	if cwd != "" && filepath.IsAbs(p) && filepath.IsAbs(cwd) {
		if rel, err := filepath.Rel(cwd, p); err == nil && rel != "" && rel != "." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && rel != ".." {
			return filepath.ToSlash(rel)
		}
	}
	return filepath.ToSlash(p)
}

func extractACPRawOutputImagePaths(raw any, cwd string) []model.ImageFile {
	m := obj(raw)
	if len(m) == 0 {
		return nil
	}
	var out []model.ImageFile
	addPath := func(candidate string) {
		if path := normalizeLocalImagePath(candidate, cwd); path != "" {
			out = appendUniqueImageFile(out, model.ImageFile{Path: path, Name: filepath.Base(path)})
		}
	}
	for _, key := range []string{"imagePath", "image_path", "savedPath", "saved_path", "outputPath", "output_path", "filePath", "file_path", "path"} {
		if s := str(m[key]); s != "" {
			addPath(s)
		}
	}
	for _, key := range []string{"imagePaths", "image_paths", "savedPaths", "saved_paths", "paths", "images"} {
		for _, entry := range arr(m[key]) {
			if s, ok := entry.(string); ok {
				addPath(s)
			} else if item := obj(entry); len(item) > 0 {
				addPath(cmp.Or(str(item["path"]), str(item["savedPath"]), str(item["imagePath"]), str(item["uri"])))
			}
		}
	}
	return out
}

func acpToolOutput(c *acpRuntime, state *acpToolState, cwd string) (string, []model.ImageFile) {
	var parts []string
	var images []model.ImageFile
	for _, entry := range state.Content {
		switch {
		case entry.Content != nil:
			text, img := resolveACPContentBlock(c, entry.Content.Content, "acp-tool-"+state.ID)
			if img != nil {
				images = appendUniqueImageFile(images, *img)
			}
			if trimmed := strings.TrimSpace(text); trimmed != "" {
				parts = append(parts, trimmed)
			}
		case entry.Diff != nil:
			parts = append(parts, formatACPDiff(entry.Diff))
		case entry.Terminal != nil && entry.Terminal.TerminalId != "":
			parts = append(parts, "terminal: "+entry.Terminal.TerminalId)
		}
	}
	for _, img := range extractACPRawOutputImagePaths(state.RawOutput, cwd) {
		images = appendUniqueImageFile(images, img)
	}
	assets, runID := "", ""
	var budget *turnImageBudget
	if c != nil {
		assets, runID, budget = c.assets, c.runID, c.imageBudget
	}
	rawImages, sanitizedRaw := extractToolOutputImages(assets, runID, "acp-raw-"+state.ID, cwd, state.RawOutput, budget)
	for _, img := range rawImages {
		images = appendUniqueImageFile(images, img)
	}
	if len(parts) > 0 {
		return strings.Join(parts, "\n\n"), images
	}
	if text := extractACPRawOutput(sanitizedRaw); text != "" {
		return text, images
	}
	return "", images
}

func acpToolDetail(c *acpRuntime, state *acpToolState, command, cwd string) (string, []model.ImageFile) {
	out, images := acpToolOutput(c, state, cwd)
	if out != "" {
		return out, images
	}
	if state.RawInput != nil {
		if input := obj(state.RawInput); len(input) > 0 {
			if command != "" && len(input) == 1 {
				return "", images
			}
			return pretty(input), images
		}
		if s, ok := state.RawInput.(string); ok {
			return strings.TrimSpace(s), images
		}
	}
	return "", images
}

func extractACPRawOutput(raw any) string {
	if raw == nil {
		return ""
	}
	if s, ok := raw.(string); ok {
		return strings.TrimSpace(s)
	}
	m := obj(raw)
	if len(m) == 0 {
		return strings.TrimSpace(pretty(raw))
	}
	if text := cmp.Or(
		str(m["combinedOutput"]),
		str(m["combined_output"]),
		str(m["output"]),
		str(m["text"]),
	); strings.TrimSpace(text) != "" {
		return strings.TrimRight(text, "\r\n")
	}
	stdout, stderr := str(m["stdout"]), str(m["stderr"])
	if stdout != "" || stderr != "" {
		return strings.TrimSpace(strings.TrimRight(stdout, "\r\n") + "\n" + strings.TrimRight(stderr, "\r\n"))
	}
	if res := obj(m["result"]); len(res) > 0 {
		if text := contentText(res["content"]); strings.TrimSpace(text) != "" {
			return strings.TrimSpace(text)
		}
	}
	return strings.TrimSpace(pretty(m))
}

func acpToolExitCode(output object) (int, bool) {
	for _, key := range []string{"exitCode", "exit_code"} {
		switch v := output[key].(type) {
		case float64:
			return int(v), true
		case int:
			return v, true
		}
	}
	return 0, false
}

func formatACPDiff(diff *acp.ToolCallContentDiff) string {
	var b strings.Builder
	if diff.Path != "" {
		b.WriteString(diff.Path)
	}
	if diff.OldText != nil && *diff.OldText != "" {
		if b.Len() > 0 {
			b.WriteByte('\n')
		}
		for _, line := range strings.Split(strings.TrimRight(*diff.OldText, "\n"), "\n") {
			b.WriteString("- ")
			b.WriteString(line)
			b.WriteByte('\n')
		}
	}
	if diff.NewText != "" {
		if b.Len() > 0 && !strings.HasSuffix(b.String(), "\n") {
			b.WriteByte('\n')
		}
		for _, line := range strings.Split(strings.TrimRight(diff.NewText, "\n"), "\n") {
			b.WriteString("+ ")
			b.WriteString(line)
			b.WriteByte('\n')
		}
	}
	return strings.TrimRight(b.String(), "\n")
}
