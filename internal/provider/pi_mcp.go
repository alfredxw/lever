package provider

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const piToolFlag = "--pi-mcp-tool"

func piAllowsMCP(args []string) bool {
	return !slices.Contains(args, "--no-mcp") && !slices.Contains(args, "--no-tools") && !slices.Contains(args, "-nt")
}

//go:embed pi_mcp.mjs
var piMCPExtension []byte

func preparePiMCP(in Input) (dir string, env []string, err error) {
	if in.MCPURL == "" || in.MCPToken == "" || !piAllowsMCP(in.Provider.Args) {
		if in.RequireMCP {
			return "", nil, errors.New("This Pi run needs Lever tools, but its MCP connection or tools are disabled")
		}
		return "", nil, nil
	}
	if err := validateLoopbackMCPURL(in.MCPURL); err != nil {
		return "", nil, err
	}
	exe, err := os.Executable()
	if err != nil {
		return "", nil, err
	}
	dir, err = os.MkdirTemp(in.Assets, ".pi-mcp-")
	if err != nil {
		return "", nil, err
	}
	if err := os.WriteFile(filepath.Join(dir, "lever.js"), piMCPExtension, 0600); err != nil {
		os.RemoveAll(dir)
		return "", nil, err
	}
	var required []string
	if in.DelegationEnabled || (in.Session.DelegationDepthAllowsMore() && len(in.Profile.Delegations) > 0) {
		required = []string{"delegate_targets", "delegate_start", "delegate_reply", "delegate_wait", "delegate_list", "delegate_cancel"}
	}
	for _, ref := range in.References {
		if tool := ref.MCPTool(); tool != "" && !slices.Contains(required, tool) {
			required = append(required, tool)
		}
	}
	return dir, []string{mcpURLEnv + "=" + in.MCPURL, mcpTokenEnv + "=" + in.MCPToken, "LEVER_PI_BRIDGE=" + exe, "LEVER_PI_READY=" + filepath.Join(dir, "ready"), "LEVER_PI_REQUIRED=" + strings.Join(required, ",")}, nil
}

func piMCPTool(ctx context.Context, endpoint, token string, input io.Reader, output io.Writer) error {
	var call mcp.CallToolParams
	if err := json.NewDecoder(input).Decode(&call); err != nil {
		return err
	}
	transport, _, err := loopbackMCPTransport(endpoint, token)
	if err != nil {
		return err
	}
	session, err := mcp.NewClient(&mcp.Implementation{Name: "lever-pi", Version: "1"}, nil).Connect(ctx, transport, nil)
	if err != nil {
		return err
	}
	defer session.Close()
	if call.Name == "" {
		tools := []*mcp.Tool{}
		for tool, err := range session.Tools(ctx, nil) {
			if err != nil {
				return err
			}
			tools = append(tools, tool)
		}
		return json.NewEncoder(output).Encode(tools)
	}
	result, err := session.CallTool(ctx, &call)
	if err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(result)
}
