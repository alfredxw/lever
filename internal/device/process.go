package device

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

func Environment() []string {
	home, _ := os.UserHomeDir()
	paths := []string{filepath.Join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"}
	nvm, _ := filepath.Glob(filepath.Join(home, ".nvm", "versions", "node", "*", "bin"))
	paths = append(paths, nvm...)
	paths = append(paths, filepath.SplitList(os.Getenv("PATH"))...)
	env := []string{}
	for _, v := range os.Environ() {
		if !strings.HasPrefix(strings.ToUpper(v), "PATH=") {
			env = append(env, v)
		}
	}
	return append(env, "PATH="+strings.Join(paths, string(os.PathListSeparator)))
}

func Executable(name string) (string, error) {
	switch name {
	case "codex", "claude", "pi", "dsh":
		if path := os.Getenv("LEVER_" + strings.ToUpper(name) + "_PATH"); path != "" {
			return exec.LookPath(path)
		}
	}
	if filepath.IsAbs(name) || strings.ContainsAny(name, `/\`) {
		return exec.LookPath(name)
	}
	// Resolve against the same PATH passed to the child, including user installs.
	for _, e := range Environment() {
		if strings.HasPrefix(e, "PATH=") {
			for _, dir := range filepath.SplitList(strings.TrimPrefix(e, "PATH=")) {
				for _, suffix := range []string{"", ".exe", ".cmd"} {
					p := filepath.Join(dir, name+suffix)
					if st, err := os.Stat(p); err == nil && !st.IsDir() && (st.Mode()&0111 != 0 || suffix != "") {
						return p, nil
					}
				}
			}
		}
	}
	return "", exec.ErrNotFound
}

func Command(path string, args ...string) *exec.Cmd {
	var pkg string
	switch strings.ToLower(filepath.Base(path)) {
	case "codex.cmd":
		pkg = "@openai/codex/bin/codex.js"
	case "claude.cmd":
		pkg = "@anthropic-ai/claude-code/cli.js"
	case "lark-cli.cmd":
		pkg = "@larksuite/cli/scripts/run.js"
	case "pi.cmd":
		pkg = "@earendil-works/pi-coding-agent/dist/cli.js"
		if _, err := os.Stat(filepath.Join(filepath.Dir(path), "node_modules", filepath.FromSlash(pkg))); errors.Is(err, os.ErrNotExist) {
			pkg = "@mariozechner/pi-coding-agent/dist/cli.js"
		}
	}
	if pkg != "" {
		script := filepath.Join(filepath.Dir(path), "node_modules", filepath.FromSlash(pkg))
		node, err := Executable("node")
		if err == nil {
			args = append([]string{script}, args...)
			path = node
		}
	}
	cmd := exec.Command(path, args...)
	cmd.Env = Environment()
	configure(cmd)
	return cmd
}

type tailBuffer struct {
	mu   sync.Mutex
	data []byte
}

func (b *tailBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.data = append(b.data, p...)
	if len(b.data) > 8192 {
		b.data = b.data[len(b.data)-8192:]
	}
	return len(p), nil
}
func (b *tailBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return strings.TrimSpace(string(b.data))
}

type Process struct {
	Cmd     *exec.Cmd
	Frames  chan json.RawMessage
	Done    chan struct{}
	in      io.WriteCloser
	mu      sync.Mutex
	err     error
	stderr  tailBuffer
	closing chan struct{}
	once    sync.Once
	kill    func() error
	release func()
}

func Start(cmd *exec.Cmd) (*Process, error) {
	return StartFrames(cmd, 32<<20)
}

// StartFrames reads newline-delimited messages up to the protocol's frame limit.
func StartFrames(cmd *exec.Cmd, limit int) (*Process, error) {
	return start(cmd, nil, limit)
}

// StartProtocol shares process-tree ownership with the native adapters while
// letting a protocol SDK own framing and request dispatch.
func StartProtocol(cmd *exec.Cmd, connect func(io.Writer, io.Reader) <-chan struct{}) (*Process, error) {
	return start(cmd, connect, 32<<20)
}

func start(cmd *exec.Cmd, connect func(io.Writer, io.Reader) <-chan struct{}, frameLimit int) (*Process, error) {
	p := &Process{Cmd: cmd, Frames: make(chan json.RawMessage, 64), Done: make(chan struct{}), closing: make(chan struct{})}
	var err error
	p.in, err = cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		_ = p.in.Close()
		return nil, err
	}
	if cmd.Stderr == nil {
		cmd.Stderr = &p.stderr
	}
	if err = cmd.Start(); err != nil {
		_ = p.in.Close()
		_ = out.Close()
		return nil, err
	}
	p.kill, p.release, err = ownProcess(cmd)
	if err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return nil, err
	}
	var protocolDone <-chan struct{}
	if connect != nil {
		protocolDone = connect(p.in, out)
	}
	go func() {
		defer close(p.Frames)
		defer close(p.Done)
		if protocolDone != nil {
			<-protocolDone
			p.err = cmd.Wait()
			return
		}
		scanner := bufio.NewScanner(out)
		scanner.Buffer(make([]byte, min(65536, frameLimit)), frameLimit)
		for scanner.Scan() {
			line := bytes.Clone(scanner.Bytes())
			if len(bytes.TrimSpace(line)) == 0 {
				continue
			}
			select {
			case p.Frames <- line:
			case <-p.closing:
			}
		}
		if scanner.Err() != nil {
			_ = p.kill()
		}
		p.err = errors.Join(scanner.Err(), cmd.Wait())
	}()
	return p, nil
}

func (p *Process) Send(v any) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return json.NewEncoder(p.in).Encode(v)
}
func (p *Process) Error() error {
	<-p.Done
	if p.err != nil && p.stderr.String() != "" {
		return errors.New(p.stderr.String())
	}
	return p.err
}

func (p *Process) Watch(ctx context.Context, interrupt func()) {
	go func() {
		select {
		case <-p.Done:
			return
		case <-ctx.Done():
			// A wedged runtime may stop reading stdin. Protocol interruption must
			// not prevent the independent deadline from killing our process tree.
			go interrupt()
		}
		select {
		case <-p.Done:
		case <-time.After(4 * time.Second):
			_ = p.kill()
		}
	}()
}

func (p *Process) Close() {
	p.close(false)
}

// Terminate stops the owned process tree before releasing its files.
func (p *Process) Terminate() {
	p.close(true)
}

func (p *Process) close(immediate bool) {
	p.once.Do(func() {
		close(p.closing)
		if immediate {
			_ = p.kill()
		}
		_ = p.in.Close()
		select {
		case <-p.Done:
		case <-time.After(4 * time.Second):
			_ = p.kill()
			<-p.Done
		}
		// Descendant tools can outlive a CLI's own stdout. Release its owned
		// process group/job as well; never scan other processes by name.
		_ = p.kill()
		p.release()
	})
}

func Output(ctx context.Context, name string, args ...string) ([]byte, error) {
	return OutputEnv(ctx, name, nil, args...)
}

type OutputError struct {
	Err    error
	Stderr string
}

func (e *OutputError) Error() string { return e.Err.Error() + ": " + e.Stderr }
func (e *OutputError) Unwrap() error { return e.Err }

func OutputEnv(ctx context.Context, name string, env []string, args ...string) ([]byte, error) {
	return output(ctx, name, env, nil, args...)
}

func OutputWithInput(ctx context.Context, name string, input io.Reader, args ...string) ([]byte, error) {
	return output(ctx, name, nil, input, args...)
}

func output(ctx context.Context, name string, env []string, input io.Reader, args ...string) ([]byte, error) {
	path, err := Executable(name)
	if err != nil {
		return nil, err
	}
	cmd := Command(path, args...)
	cmd.Env = append(cmd.Env, env...)
	cmd.Stdin = input
	return OutputCommand(ctx, cmd)
}

// OutputCommand captures stdout and cancels the whole process group on timeout.
func OutputCommand(ctx context.Context, cmd *exec.Cmd) ([]byte, error) {
	var out bytes.Buffer
	err := WriteCommandOutput(ctx, cmd, &out)
	if err != nil && err == ctx.Err() {
		return nil, err
	}
	return out.Bytes(), err
}

// WriteCommandOutput streams large results while preserving process-tree cancellation.
func WriteCommandOutput(ctx context.Context, cmd *exec.Cmd, out io.Writer) error {
	var stderr tailBuffer
	cmd.Stdout = out
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return err
	}
	kill, release, err := ownProcess(cmd)
	if err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return err
	}
	defer release()
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		if detail := stderr.String(); err != nil && detail != "" {
			err = &OutputError{Err: err, Stderr: detail}
		}
		return err
	case <-ctx.Done():
		_ = kill()
		<-done
		return ctx.Err()
	}
}
