// Package cli handles commands shared by the desktop and server binaries.
package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"lever/internal/localipc"
	"lever/internal/model"
)

const executionTokenEnv = "LEVER_EXECUTION_TOKEN"

const UsageText = `Usage: lever [server flags]
       lever agent list|get|create|update [flags]
       lever providers list|models [flags]
       lever chat list|create|send [flags]
       lever run get|wait|stop|pause|resume|answer [flags]
       lever context find|read [flags]
       lever automations list|get|create|update|enable|disable|archive|run|history|emit|import-codex [flags]
       lever work-items list|get|create|update|dispatch [flags]
       lever notes list|get|create [flags]
       lever events tail [flags]`

func Run(args []string, dataDir string, out, errOut io.Writer) (bool, error) {
	return RunWithInput(args, dataDir, os.Stdin, out, errOut)
}

func RunWithInput(args []string, dataDir string, in io.Reader, out, errOut io.Writer) (bool, error) {
	if len(args) == 0 {
		return false, nil
	}
	switch args[0] {
	case "agent":
		return true, runAgent(args[1:], dataDir, in, out, errOut)
	case "providers":
		return true, runProviders(args[1:], dataDir, out, errOut)
	case "automations":
		return true, runAutomations(args[1:], dataDir, in, out, errOut)
	case "chat":
		return true, runChat(args[1:], dataDir, in, out, errOut)
	case "run":
		return true, runRun(args[1:], dataDir, out, errOut)
	case "context":
		return true, runContext(args[1:], dataDir, out, errOut)
	case "work-items":
		return true, runWorkItems(args[1:], dataDir, out, errOut)
	case "notes":
		return true, runNotes(args[1:], dataDir, in, out, errOut)
	case "events":
		return true, runEvents(args[1:], dataDir, out, errOut)
	default:
		return false, nil
	}
}

type stringList []string

func (s *stringList) String() string { return strings.Join(*s, ",") }
func (s *stringList) Set(value string) error {
	value = strings.TrimSpace(value)
	if value != "" {
		*s = append(*s, value)
	}
	return nil
}

type optionalBool struct {
	set   bool
	value bool
}

func (b *optionalBool) String() string {
	if !b.set {
		return ""
	}
	if b.value {
		return "true"
	}
	return "false"
}
func (b *optionalBool) IsBoolFlag() bool { return true }
func (b *optionalBool) Set(raw string) error {
	b.set = true
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "", "true", "1", "yes":
		b.value = true
		return nil
	case "false", "0", "no":
		b.value = false
		return nil
	default:
		return fmt.Errorf("invalid boolean value %q", raw)
	}
}

type selectionFlags struct {
	provider   string
	model      string
	effort     string
	permission string
	fast       optionalBool
}

func (f *selectionFlags) register(fs *flag.FlagSet) {
	fs.StringVar(&f.provider, "provider", "", "Runtime provider ID override")
	fs.StringVar(&f.model, "model", "", "Model ID override")
	fs.StringVar(&f.effort, "effort", "", "Reasoning effort override (e.g. low, medium, high, xhigh, max)")
	fs.StringVar(&f.permission, "permission", "", "Permission policy override (e.g. ask, auto_review, accept_edits, full_access)")
	fs.Var(&f.fast, "fast", "Enable fast mode (true/false)")
}

func (f *selectionFlags) toSelection() *model.Selection {
	sel := model.Selection{
		Provider:   strings.TrimSpace(f.provider),
		Model:      strings.TrimSpace(f.model),
		Effort:     strings.TrimSpace(f.effort),
		Permission: strings.TrimSpace(f.permission),
		Fast:       f.fast.set && f.fast.value,
	}
	if sel == (model.Selection{}) && !f.fast.set {
		return nil
	}
	return &sel
}

func parseFlags(flags *flag.FlagSet, args []string) error {
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("expected flags after the command")
	}
	return nil
}

func readTextArg(value string, in io.Reader, limit int64) (string, error) {
	if value != "" && value != "-" {
		return value, nil
	}
	if in == nil {
		return "", nil
	}
	if value == "" {
		if file, ok := in.(*os.File); ok {
			if info, err := file.Stat(); err == nil && info.Mode()&os.ModeCharDevice != 0 {
				return "", nil
			}
		}
	}
	raw, err := io.ReadAll(io.LimitReader(in, limit+1))
	if err != nil {
		return "", err
	}
	if int64(len(raw)) > limit {
		return "", fmt.Errorf("input exceeds %d bytes", limit)
	}
	return string(raw), nil
}

func readJSONArg(raw string, in io.Reader, limit int64, dst any) error {
	text, err := readTextArg(raw, in, limit)
	if err != nil {
		return err
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return errors.New("expected JSON payload via --json or stdin")
	}
	dec := json.NewDecoder(strings.NewReader(text))
	if err := dec.Decode(dst); err != nil {
		return fmt.Errorf("invalid JSON: %w", err)
	}
	return nil
}

func ipcClient(dataDir string, timeout time.Duration) http.Client {
	return http.Client{
		Timeout:       timeout,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		Transport: &http.Transport{
			DisableKeepAlives: true,
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return localipc.Dial(ctx, dataDir)
			},
		},
	}
}

func request(dataDir, method, path, token string, input any, out io.Writer) error {
	return requestWithTimeout(dataDir, method, path, token, nil, input, 10*time.Second, out)
}

func requestWithHeaders(dataDir, method, path, token string, headers map[string]string, input any, out io.Writer) error {
	return requestWithTimeout(dataDir, method, path, token, headers, input, 10*time.Second, out)
}

func requestWithTimeout(dataDir, method, path, token string, headers map[string]string, input any, timeout time.Duration, out io.Writer) error {
	raw, err := requestRaw(context.Background(), dataDir, method, path, token, headers, input, timeout)
	if err != nil {
		return err
	}
	if out == nil {
		return nil
	}
	return json.NewEncoder(out).Encode(raw)
}

func requestDecode(ctx context.Context, dataDir, method, path, token string, headers map[string]string, input any, timeout time.Duration, dst any) error {
	raw, err := requestRaw(ctx, dataDir, method, path, token, headers, input, timeout)
	if err != nil {
		return err
	}
	if dst == nil {
		return nil
	}
	return json.Unmarshal(raw, dst)
}

func requestRaw(ctx context.Context, dataDir, method, path, token string, headers map[string]string, input any, timeout time.Duration) (json.RawMessage, error) {
	var body io.Reader
	if input != nil {
		data, err := json.Marshal(input)
		if err != nil {
			return nil, err
		}
		body = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, "http://lever"+path, body)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	client := ipcClient(dataDir, timeout)
	res, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("connect to the running Lever instance for %q: %w", dataDir, err)
	}
	defer res.Body.Close()
	decoder := json.NewDecoder(res.Body)
	if res.StatusCode != http.StatusOK {
		var payload struct{ Error string }
		if decoder.Decode(&payload) == nil && payload.Error != "" {
			return nil, fmt.Errorf("Lever: %s", payload.Error)
		}
		return nil, fmt.Errorf("Lever: %s", res.Status)
	}
	var result json.RawMessage
	if err := decoder.Decode(&result); err != nil {
		return nil, err
	}
	return result, nil
}

func requestStream(ctx context.Context, dataDir, path, token string, out io.Writer) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://lever"+path, nil)
	if err != nil {
		return err
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	client := ipcClient(dataDir, 0)
	res, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("connect to the running Lever instance for %q: %w", dataDir, err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		var payload struct{ Error string }
		if json.NewDecoder(res.Body).Decode(&payload) == nil && payload.Error != "" {
			return fmt.Errorf("Lever: %s", payload.Error)
		}
		return fmt.Errorf("Lever: %s", res.Status)
	}
	_, err = io.Copy(out, res.Body)
	return err
}
