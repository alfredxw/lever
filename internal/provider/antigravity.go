package provider

// Protocol framing, turns, approvals and persistence stay in the ACP adapter.
import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"lever/internal/device"
	"lever/internal/model"
)

type stateDirKey struct{}

// WithStateDir supplies the host-owned directory for managed runtimes and profiles.
func WithStateDir(ctx context.Context, dir string) context.Context {
	return context.WithValue(ctx, stateDirKey{}, dir)
}

func antigravityDir(ctx context.Context) (string, error) {
	dir, _ := ctx.Value(stateDirKey{}).(string)
	if dir == "" {
		return "", errors.New("Antigravity requires the host state directory")
	}
	return filepath.Abs(dir)
}

func antigravityProfileDir(dir, id string) string {
	key := fmt.Sprintf("%x", sha256.Sum256([]byte(id)))
	return filepath.Join(dir, "providers", "antigravity", key)
}

func setupTimeout(config model.Provider) time.Duration {
	switch config.Type {
	case "antigravity":
		return 90 * time.Second
	case "pi":
		return piSetupTimeout
	case "acp":
		return 45 * time.Second
	default:
		return 15 * time.Second
	}
}

func antigravityNames() (string, string) {
	if runtime.GOOS == "windows" {
		return "agy_acp_server.exe", "localharness_external.exe"
	}
	return "agy_acp_server.par", "localharness_external"
}

func antigravityInstallDir(ctx context.Context) (string, error) {
	dir, err := antigravityDir(ctx)
	return filepath.Join(dir, "tools", "antigravity", runtime.GOOS+"-"+runtime.GOARCH, antigravityVersion), err
}

var errAntigravityNotInstalled = errors.New("Install Antigravity in Settings → Providers, or select an official ACP executable")

func antigravityExecutable(ctx context.Context, config model.Provider) (string, error) {
	if config.Command != "" {
		if config.Command == "agy" {
			if path := os.Getenv("LEVER_ANTIGRAVITY_PATH"); path != "" {
				return device.Executable(path)
			}
		}
		return device.Executable(config.Command)
	}
	if path := os.Getenv("LEVER_ANTIGRAVITY_PATH"); path != "" {
		return device.Executable(path)
	}
	if dir, err := antigravityInstallDir(ctx); err == nil {
		name, _ := antigravityNames()
		if path, err := device.Executable(filepath.Join(dir, name)); err == nil && antigravityInstalled(dir, antigravityReleases[runtime.GOOS+"-"+runtime.GOARCH]) {
			return path, nil
		}
	}
	name, _ := antigravityNames()
	if path, err := device.Executable(name); err == nil {
		return path, nil
	}
	return "", errAntigravityNotInstalled
}

func IsAntigravityCLI(config model.Provider, path string) bool {
	if config.Command == "agy" {
		return true
	}
	name := strings.ToLower(strings.TrimSuffix(filepath.Base(path), filepath.Ext(path)))
	return name == "agy" || name == "antigravity"
}

const antigravityAuthPrefix = "Open the following link to authenticate the ACP server: "
const antigravityBrowserMarker = "__LEVER_ANTIGRAVITY_AUTH_URL__"

var errAntigravitySignIn = errors.New("Sign in to Antigravity in Settings → Providers before continuing")
var errAntigravityCLISignIn = errors.New("Sign in through the local Antigravity CLI with agy --login, then refresh models")

// AntigravityBrowserHelper handles Python's BROWSER callback without opening a
// browser during catalog reads or background turns. Only setup exposes the URL.
func AntigravityBrowserHelper() bool {
	if len(os.Args) != 3 || os.Args[1] != "--antigravity-auth-url" {
		return false
	}
	b, _ := json.Marshal(os.Args[2])
	fmt.Fprintln(os.Stderr, antigravityBrowserMarker+string(b))
	return true
}

func antigravityAuthorizationURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || len(raw) > 16384 || strings.ContainsAny(raw, " \r\n\t") || u.User != nil || u.Fragment != "" || u.Scheme != "https" || u.Host != "accounts.google.com" || u.Path != "/o/oauth2/v2/auth" {
		return errors.New("Antigravity returned an invalid Google sign-in URL")
	}
	q := u.Query()
	r, err := url.Parse(q.Get("redirect_uri"))
	if err != nil || r.Scheme != "http" || r.Hostname() != "127.0.0.1" || r.Port() == "" || r.Path != "/" || r.User != nil || r.RawQuery != "" || r.Fragment != "" || q.Get("state") == "" || len(q["state"]) != 1 || len(q["redirect_uri"]) != 1 || len(q["response_type"]) != 1 || q.Get("response_type") != "code" {
		return errors.New("Antigravity returned an invalid Google sign-in callback")
	}
	port, err := strconv.Atoi(r.Port())
	if err != nil || port < 1024 || port > 65535 || len(q.Get("state")) > 512 || strings.ContainsAny(q.Get("state"), " \r\n\t") {
		return errors.New("Antigravity returned an invalid Google sign-in callback")
	}
	return nil
}

func antigravityBrowserCommand() (string, error) {
	helper, err := os.Executable()
	if err != nil {
		return "", err
	}
	helper = filepath.ToSlash(helper)
	separator := ":"
	if runtime.GOOS == "windows" {
		separator = ";"
	}
	if strings.ContainsAny(helper, separator+"\x00\r\n") || strings.Contains(helper, "%s") {
		return "", errors.New("Lever's executable path cannot be used for Antigravity sign-in")
	}
	return "'" + strings.ReplaceAll(helper, "'", "'\"'\"'") + "' --antigravity-auth-url %s", nil
}

func antigravityCommand(ctx context.Context, config model.Provider, path, cwd string, preset *antigravityPreset, processPerSession bool) (*exec.Cmd, func(), error) {
	browser, err := antigravityBrowserCommand()
	if err != nil {
		return nil, nil, err
	}
	if IsAntigravityCLI(config, path) {
		if config.AuthMethod != "" {
			return nil, nil, errors.New("Local agy uses the authentication configured in its CLI")
		}
		// Local agy owns its account, settings and GEMINI_HOME.
		// --process-per-session enables per-session HTTP MCP support in agy acp.
		args := []string{"acp"}
		if processPerSession {
			args = append(args, "--process-per-session")
		}
		cleanup := func() {}
		if preset != nil {
			var override []string
			override, cleanup, err = antigravityPresetArgs(cwd, preset)
			if err != nil {
				return nil, nil, err
			}
			args = append(args, override...)
		}
		cmd := device.Command(path, args...)
		cmd.Dir = cwd
		env := []string{}
		for _, value := range cmd.Env {
			key, _, _ := strings.Cut(value, "=")
			if !strings.EqualFold(key, "BROWSER") {
				env = append(env, value)
			}
		}
		cmd.Env = append(env, "BROWSER="+browser)
		return cmd, cleanup, nil
	}
	dir, err := antigravityDir(ctx)
	if err != nil {
		return nil, nil, err
	}
	profile := antigravityProfileDir(dir, config.ID)
	acpDir := filepath.Join(profile, "antigravity-acp")
	if err := os.MkdirAll(acpDir, 0700); err != nil {
		return nil, nil, err
	}
	credential, err := antigravityCredential(ctx, config)
	if err != nil {
		return nil, nil, err
	}
	settings := object{"auth": object{"type": antigravityAuthMethod(config)}}
	if config.GCPProject != "" || config.GCPLocation != "" {
		settings["gcp"] = object{"project": config.GCPProject, "location": config.GCPLocation}
	}
	if err := writeProfileFile(filepath.Join(acpDir, "settings.json"), []byte(pretty(settings))); err != nil {
		return nil, nil, err
	}
	temp, err := os.MkdirTemp(acpDir, "tmp-")
	if err != nil {
		return nil, nil, err
	}
	cleanup := func() { _ = os.RemoveAll(temp) }
	args := []string{}
	if runtime.GOOS == "linux" {
		args = append(args, "--uid=")
	}
	cmd := device.Command(path, args...)
	cmd.Dir = cwd
	remove := map[string]bool{}
	for _, key := range strings.Fields("GEMINI_API_KEY GOOGLE_API_KEY GOOGLE_APPLICATION_CREDENTIALS GOOGLE_CLOUD_PROJECT GOOGLE_CLOUD_LOCATION GOOGLE_CLOUD_QUOTA_PROJECT GOOGLE_GENAI_USE_VERTEXAI GCLOUD_PROJECT CLOUDSDK_CORE_PROJECT AGY_ACP_CCPA_PROJECT AGY_ACP_ENABLE_OAUTH GEMINI_HOME AGY_ACP_FORCE_FILE_STORAGE ANTIGRAVITY_HARNESS_PATH BROWSER PYTHONUNBUFFERED ELECTRON_RUN_AS_NODE CHROME_CRASHPAD_PIPE_NAME TMPDIR TEMP TMP") {
		remove[key] = true
	}
	env := []string{}
	for _, value := range cmd.Env {
		key, _, _ := strings.Cut(value, "=")
		if key == "GOOGLE_APPLICATION_CREDENTIALS" && config.AuthMethod == "agent-platform" && credential == "" {
			env = append(env, value)
			continue
		}
		if !remove[strings.ToUpper(key)] {
			env = append(env, value)
		}
	}
	cmd.Env = append(env, "GEMINI_HOME="+profile, "AGY_ACP_FORCE_FILE_STORAGE=1", "PYTHONUNBUFFERED=1", "BROWSER="+browser, "TMPDIR="+temp, "TEMP="+temp, "TMP="+temp)
	if credential != "" {
		cmd.Env = append(cmd.Env, credential)
	}
	if runtime.GOOS == "linux" && os.Getenv("SSL_CERT_FILE") == "" && os.Getenv("SSL_CERT_DIR") == "" {
		for _, path := range []string{os.Getenv("NIX_SSL_CERT_FILE"), "/etc/ssl/certs/ca-bundle.crt", "/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt", "/etc/ssl/cert.pem"} {
			if info, err := os.Stat(path); filepath.IsAbs(path) && err == nil && info.Mode().IsRegular() {
				cmd.Env = append(cmd.Env, "SSL_CERT_FILE="+path)
				break
			}
		}
	}
	if !IsAntigravityCLI(config, path) {
		_, harnessName := antigravityNames()
		resolved, err := filepath.EvalSymlinks(path)
		if err != nil {
			cleanup()
			return nil, nil, err
		}
		harness, err := device.Executable(filepath.Join(filepath.Dir(resolved), harnessName))
		if err != nil {
			cleanup()
			return nil, nil, errors.New("Antigravity ACP needs localharness_external from the same release beside its executable")
		}
		cmd.Env = append(cmd.Env, "ANTIGRAVITY_HARNESS_PATH="+harness)
	}
	return cmd, cleanup, nil
}

type antigravityOutput struct {
	mu                           sync.Mutex
	err                          error
	unsupportedProcessPerSession bool
	stderr                       string
	reader                       *io.PipeReader
	onURL                        func(string)
	cancel                       context.CancelFunc
	nativeCLI                    bool
}

func (o *antigravityOutput) processPerSessionUnsupported() bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.unsupportedProcessPerSession
}

func (o *antigravityOutput) authorization(raw string) {
	err := antigravityAuthorizationURL(raw)
	if err == nil && o.onURL == nil {
		err = errAntigravitySignIn
		if o.nativeCLI {
			err = errAntigravityCLISignIn
		}
	}
	if err != nil {
		o.mu.Lock()
		o.err = err
		o.mu.Unlock()
		o.cancel()
		return
	}
	o.onURL(raw)
}

func (o *antigravityOutput) failure(err error) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.err != nil {
		return o.err
	}
	return err
}

func (o *antigravityOutput) stdout(r io.Reader) io.Reader {
	reader, writer := io.Pipe()
	o.reader = reader
	go func() {
		scanner := bufio.NewScanner(r)
		scanner.Buffer(make([]byte, 65536), 32<<20)
		for scanner.Scan() {
			line := scanner.Text()
			if raw, ok := strings.CutPrefix(line, antigravityAuthPrefix); ok {
				o.authorization(raw)
				if err := o.failure(nil); err != nil {
					_ = writer.CloseWithError(err)
					return
				}
				continue
			}
			if _, err := fmt.Fprintln(writer, line); err != nil {
				return
			}
		}
		_ = writer.CloseWithError(scanner.Err())
	}()
	return reader
}

func (o *antigravityOutput) Write(b []byte) (int, error) {
	// stderr is a single process pipe; retain only an incomplete bounded line.
	o.stderr += string(b)
	for {
		line, rest, found := strings.Cut(o.stderr, "\n")
		if !found {
			break
		}
		o.stderr = rest
		line = strings.TrimSuffix(line, "\r")
		if raw, ok := strings.CutPrefix(line, antigravityBrowserMarker); ok {
			var link string
			if json.Unmarshal([]byte(raw), &link) == nil {
				o.authorization(link)
			}
		} else if raw, ok := strings.CutPrefix(line, antigravityAuthPrefix); ok {
			o.authorization(raw)
		} else if o.nativeCLI && isUnsupportedProcessPerSession(line) {
			o.mu.Lock()
			o.unsupportedProcessPerSession = true
			o.mu.Unlock()
		}
	}
	if len(o.stderr) > 32768 {
		o.stderr = ""
	}
	return len(b), nil
}

func isUnsupportedProcessPerSession(line string) bool {
	lower := strings.ToLower(line)
	return strings.Contains(lower, "process-per-session") &&
		(strings.Contains(lower, "not defined") || strings.Contains(lower, "unknown flag") || strings.Contains(lower, "unrecognized"))
}

// SignInAntigravity verifies authentication and account model access without a prompt.
func SignInAntigravity(ctx context.Context, config model.Provider, onURL func(string)) error {
	path, err := Executable(ctx, config)
	if err != nil {
		return err
	}
	if IsAntigravityCLI(config, path) {
		return errAntigravityCLISignIn
	}
	dir, err := antigravityProbeDir(ctx)
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	c, err := openACPWithAuth(ctx, config, dir, nil, onURL, "")
	if err != nil {
		return err
	}
	var state acpState
	defer func() { c.close(); removeAntigravityProbe(ctx, config, string(state.SessionID), dir) }()
	state, err = c.sessionState(ctx, dir, "", nil, nil)
	if err == nil && (state.option("model") == nil || len(acpChoices(state.option("model"))) == 0) && (state.Models == nil || len(state.Models.AvailableModels) == 0) {
		err = errors.New("Antigravity returned no available models. Check this Google account's access.")
	}
	return c.failure(err)
}

func antigravityProbeDir(ctx context.Context) (string, error) {
	dir, err := antigravityDir(ctx)
	if err != nil {
		return "", err
	}
	return os.MkdirTemp(dir, ".antigravity-probe-")
}

func removeAntigravityProbe(ctx context.Context, config model.Provider, native, cwd string) {
	if path, err := Executable(ctx, config); err != nil || IsAntigravityCLI(config, path) {
		return
	}
	if !antigravitySessionID.MatchString(native) {
		return
	}
	dir, err := antigravityDir(ctx)
	if err != nil {
		return
	}
	root, err := os.OpenRoot(antigravityProfileDir(dir, config.ID))
	if err != nil {
		return
	}
	defer root.Close()
	base := filepath.Join("antigravity-acp", "conversations", native)
	file, err := root.Open(base + ".meta")
	if err != nil {
		return
	}
	data, err := io.ReadAll(io.LimitReader(file, 65537))
	file.Close()
	var meta struct {
		CWD string `json:"cwd"`
	}
	if err != nil || len(data) > 65536 || json.Unmarshal(data, &meta) != nil || meta.CWD != cwd {
		return
	}
	for _, suffix := range []string{".db", ".db-wal", ".db-shm", ".db-journal", ".meta"} {
		_ = root.Remove(base + suffix)
	}
	_ = root.RemoveAll(filepath.Join("antigravity-acp", "brain", native))
}
