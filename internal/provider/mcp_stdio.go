package provider

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"sync"
	"syscall"

	acp "github.com/coder/acp-go-sdk"
	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const (
	mcpStdioFlag = "--mcp-stdio"
	mcpURLEnv    = "LEVER_MCP_URL"
	mcpTokenEnv  = "LEVER_MCP_TOKEN"
)

// MCPStdioHelper bridges an ACP runtime's baseline stdio MCP transport to
// Lever's per-execution loopback Streamable HTTP MCP endpoint.
func MCPStdioHelper() bool {
	if len(os.Args) != 2 || (os.Args[1] != mcpStdioFlag && os.Args[1] != piToolFlag) {
		return false
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	var err error
	if os.Args[1] == piToolFlag {
		err = piMCPTool(ctx, os.Getenv(mcpURLEnv), os.Getenv(mcpTokenEnv), os.Stdin, os.Stdout)
	} else {
		err = bridgeMCPStdio(ctx, os.Getenv(mcpURLEnv), os.Getenv(mcpTokenEnv), &mcp.StdioTransport{})
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	return true
}

func mcpStdioServer(rawURL, token string) (acp.McpServer, error) {
	if err := validateLoopbackMCPURL(rawURL); err != nil {
		return acp.McpServer{}, err
	}
	if token == "" {
		return acp.McpServer{}, errors.New("MCP capability token is missing")
	}
	exe, err := os.Executable()
	if err != nil {
		return acp.McpServer{}, err
	}
	return acp.McpServer{Stdio: &acp.McpServerStdio{
		Name:    "lever",
		Command: exe,
		Args:    []string{mcpStdioFlag},
		Env: []acp.EnvVariable{
			{Name: mcpURLEnv, Value: rawURL},
			{Name: mcpTokenEnv, Value: token},
		},
	}}, nil
}

func validateLoopbackMCPURL(rawURL string) error {
	u, err := url.Parse(rawURL)
	if err != nil || u.Scheme != "http" || u.User != nil || u.Path != "/mcp" || u.RawQuery != "" || u.Fragment != "" || u.Port() == "" {
		return errors.New("MCP bridge requires a loopback http://<host>:<port>/mcp URL")
	}
	ip := net.ParseIP(u.Hostname())
	if ip == nil || !ip.IsLoopback() {
		return errors.New("MCP bridge only connects to loopback addresses")
	}
	return nil
}

type mcpBridgeRoundTripper struct {
	base            http.RoundTripper
	token           string
	mu              sync.Mutex
	protocolVersion string
}

func (t *mcpBridgeRoundTripper) setProtocolVersion(version string) {
	t.mu.Lock()
	t.protocolVersion = version
	t.mu.Unlock()
}

func (t *mcpBridgeRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	out := req.Clone(req.Context())
	out.Header.Set("Authorization", "Bearer "+t.token)
	if out.Header.Get("MCP-Protocol-Version") == "" {
		t.mu.Lock()
		version := t.protocolVersion
		t.mu.Unlock()
		if version != "" {
			out.Header.Set("MCP-Protocol-Version", version)
		}
	}
	return t.base.RoundTrip(out)
}

func loopbackMCPTransport(rawURL, token string) (*mcp.StreamableClientTransport, *mcpBridgeRoundTripper, error) {
	if err := validateLoopbackMCPURL(rawURL); err != nil {
		return nil, nil, err
	}
	if token == "" {
		return nil, nil, errors.New("MCP bridge requires an execution capability token")
	}
	rt := &mcpBridgeRoundTripper{
		base:  &http.Transport{DisableKeepAlives: true},
		token: token,
	}
	httpClient := &http.Client{
		Transport:     rt,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	return &mcp.StreamableClientTransport{
		Endpoint:             rawURL,
		HTTPClient:           httpClient,
		DisableStandaloneSSE: true,
		MaxRetries:           -1,
	}, rt, nil
}

func bridgeMCPStdio(ctx context.Context, rawURL, token string, local mcp.Transport) error {
	transport, rt, err := loopbackMCPTransport(rawURL, token)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stdioConn, err := local.Connect(ctx)
	if err != nil {
		return err
	}
	defer stdioConn.Close()
	httpConn, err := transport.Connect(ctx)
	if err != nil {
		return err
	}
	defer httpConn.Close()

	var (
		mu       sync.Mutex
		initID   jsonrpc.ID
		hasInit  bool
		inflight = map[jsonrpc.ID]context.CancelFunc{}
		wg       sync.WaitGroup
	)
	finishCall := func(id jsonrpc.ID) bool {
		mu.Lock()
		defer mu.Unlock()
		stop, ok := inflight[id]
		if ok {
			stop()
			delete(inflight, id)
		}
		return ok
	}

	httpErr := make(chan error, 1)
	go func() {
		defer func() {
			cancel()
			_ = stdioConn.Close()
		}()
		for {
			msg, err := httpConn.Read(ctx)
			if err != nil {
				httpErr <- err
				return
			}
			if resp, ok := msg.(*jsonrpc.Response); ok {
				finishCall(resp.ID)
				mu.Lock()
				isInit := hasInit && resp.ID == initID
				if isInit {
					hasInit = false
				}
				mu.Unlock()
				if isInit && resp.Error == nil {
					var result struct {
						ProtocolVersion string `json:"protocolVersion"`
					}
					if json.Unmarshal(resp.Result, &result) == nil && result.ProtocolVersion != "" {
						rt.setProtocolVersion(result.ProtocolVersion)
					}
				}
			}
			if err := stdioConn.Write(ctx, msg); err != nil {
				httpErr <- err
				return
			}
		}
	}()

	var stdioErr error
	for {
		msg, err := stdioConn.Read(ctx)
		if err != nil {
			if !errors.Is(err, io.EOF) && ctx.Err() == nil {
				stdioErr = err
			}
			break
		}
		req, isReq := msg.(*jsonrpc.Request)
		if isReq && req.Method == "notifications/cancelled" {
			var params struct {
				RequestID any `json:"requestId"`
			}
			if json.Unmarshal(req.Params, &params) == nil && params.RequestID != nil {
				if id, err := jsonrpc.MakeID(params.RequestID); err == nil {
					finishCall(id)
				}
			}
		}
		if isReq && req.IsCall() && req.Method == "initialize" {
			mu.Lock()
			initID, hasInit = req.ID, true
			mu.Unlock()
			if err := httpConn.Write(ctx, msg); err != nil {
				if ctx.Err() == nil {
					_ = stdioConn.Write(ctx, &jsonrpc.Response{
						ID:    req.ID,
						Error: &jsonrpc.Error{Code: jsonrpc.CodeInternalError, Message: err.Error()},
					})
				}
			}
			continue
		}
		if isReq && req.IsCall() {
			callCtx, stopCall := context.WithCancel(ctx)
			mu.Lock()
			inflight[req.ID] = stopCall
			mu.Unlock()
			wg.Add(1)
			go func(req *jsonrpc.Request, callCtx context.Context) {
				defer wg.Done()
				if err := httpConn.Write(callCtx, req); err != nil {
					if finishCall(req.ID) && ctx.Err() == nil {
						_ = stdioConn.Write(ctx, &jsonrpc.Response{
							ID:    req.ID,
							Error: &jsonrpc.Error{Code: jsonrpc.CodeInternalError, Message: err.Error()},
						})
					}
				}
			}(req, callCtx)
			continue
		}
		if err := httpConn.Write(ctx, msg); err != nil && ctx.Err() == nil {
			stdioErr = err
			break
		}
	}

	cancel()
	_ = httpConn.Close()
	_ = stdioConn.Close()
	wg.Wait()
	select {
	case err := <-httpErr:
		if stdioErr == nil && err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, context.Canceled) {
			return err
		}
	default:
	}
	return stdioErr
}
