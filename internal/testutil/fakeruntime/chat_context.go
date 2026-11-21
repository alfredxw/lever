package main

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func chatContextReceipt(transport mcp.Transport, input, script string) (string, error) {
	if transport == nil {
		return "", errors.New("missing Lever MCP server")
	}
	var calls []struct {
		Name      string `json:"name"`
		Arguments object `json:"arguments"`
		Continue  bool   `json:"continue"`
	}
	// References may add tool instructions after the scripted calls.
	if err := json.NewDecoder(strings.NewReader(script)).Decode(&calls); err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	session, err := connectFixtureMCP(ctx, transport)
	if err != nil {
		return "", err
	}
	defer session.Close()
	list, err := session.ListTools(ctx, nil)
	if err != nil {
		return "", err
	}
	names := []string{}
	for _, tool := range list.Tools {
		names = append(names, tool.Name)
	}
	results := []object{}
	var cursor any
	for _, call := range calls {
		if call.Continue {
			call.Arguments["cursor"] = cursor
		}
		result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: call.Name, Arguments: call.Arguments})
		if err != nil {
			return "", err
		}
		text := result.Content[0].(*mcp.TextContent).Text
		if result.IsError {
			results = append(results, object{"error": text})
			continue
		}
		var page object
		if err := json.Unmarshal([]byte(text), &page); err != nil {
			return "", err
		}
		cursor = page["nextCursor"]
		results = append(results, object{"body": json.RawMessage(text), "bytes": len(text)})
	}
	raw, err := json.Marshal(object{"input": input, "tools": names, "results": results})
	return "context:" + string(raw), err
}
