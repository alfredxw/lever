package cli

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"syscall"
	"time"

	"lever/internal/remote"
	p "lever/internal/remoteproto"
	"lever/internal/store"
)

func runRemote(args []string, dir string, in io.Reader, out, errOut io.Writer) error {
	if os.Getenv(executionTokenEnv) != "" {
		return errors.New("remote management requires a local operator")
	}
	if len(args) == 0 || args[0] == "--help" {
		fmt.Fprintln(out, "lever remote pair|status|devices|agents|trusted|trust|untrust|permission|lan|inbox|accept|decline|unpair [--data-dir DIR] [--space-id ID --hub-id ID]")
		return nil
	}
	op := args[0]
	args = args[1:]
	v := remote.Management{Action: op}
	if op == "agents" {
		if len(args) == 0 {
			v.Action = "status"
		} else if (args[0] == "expose" || args[0] == "hide") && len(args) >= 2 {
			v.Action = args[0]
			v.AgentID = args[1]
			args = args[2:]
		} else {
			return errors.New("usage: lever remote agents [expose|hide AGENT_ID]")
		}
	}
	if op == "accept" || op == "decline" {
		if len(args) == 0 {
			return errors.New("command ID required")
		}
		v.ID = args[0]
		args = args[1:]
	}
	fs := flag.NewFlagSet("remote "+op, flag.ContinueOnError)
	fs.SetOutput(errOut)
	fs.StringVar(&dir, "data-dir", dir, "Host data directory")
	fs.StringVar(&v.Scope.HubID, "hub-id", "", "paired Hub ID")
	fs.StringVar(&v.Scope.SpaceID, "space-id", "", "paired space ID")
	fs.StringVar(&v.Pair.Hub, "hub", "", "Hub origin")
	role := fs.String("role", "executor", "executor, controller or workstation")
	fs.StringVar(&v.Pair.Name, "name", "", "device name")
	fs.StringVar(&v.ControllerID, "controller", "", "paired personal controller ID")
	fs.StringVar(&v.AgentID, "agent", v.AgentID, "exposed Agent ID")
	fs.StringVar(&v.Operation, "operation", "", "send, answer, stop or dispatch_task")
	fs.BoolVar(&v.Enabled, "enabled", false, "enable LAN or grant this operation")
	stdinCode := fs.Bool("code-stdin", false, "read the one-time code from stdin")
	fs.StringVar(&v.Pair.Code, "code", "", "one-time pairing code")
	fs.StringVar(&v.Pair.Link, "link", "", "Hub or pinned LAN pairing link")
	access := fs.String("access", "", "chat, workspace or admin")
	var expose optionalBool
	fs.Var(&expose, "expose-all", "expose all non-archived Agents")
	fs.BoolVar(&v.Pair.NoControl, "no-control", false, "disable controlling other devices")
	jsonStatus := fs.Bool("json", false, "include node route diagnostics in status")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 0 {
		return errors.New("unexpected positional argument")
	}
	if op == "status" && *jsonStatus {
		v.Action = "diagnostics"
	}
	if op == "access" {
		v.AccessLevel = p.AccessLevel(*access)
	}
	if op == "pair" {
		v.Pair.Access = p.AccessLevel(*access)
		if expose.set {
			v.Pair.ExposeAll = &expose.value
		}
		v.Pair.Role = p.Role(*role)
		if !v.Pair.Role.Valid() {
			return errors.New("invalid role")
		}
		if v.Pair.Link != "" && (v.Pair.Code != "" || *stdinCode || v.Pair.Hub != "") || v.Pair.Code != "" && *stdinCode {
			return errors.New("choose one of --link, --code or --code-stdin")
		}
		if v.Pair.Link != "" && strings.Contains(v.Pair.Link, "lan=") && v.Pair.Role == p.Executor && !v.Pair.NoControl {
			explicitRole := false
			fs.Visit(func(f *flag.Flag) {
				if f.Name == "role" {
					explicitRole = true
				}
			})
			if !explicitRole {
				v.Pair.Role = p.Workstation
			}
		}
		if v.Pair.Link == "" && v.Pair.Code == "" {
			if !*stdinCode {
				fmt.Fprint(errOut, "Pairing code: ")
			}
			code, err := bufio.NewReader(io.LimitReader(in, 256)).ReadString('\n')
			if err != nil && !errors.Is(err, io.EOF) {
				return err
			}
			v.Pair.Code = strings.TrimSpace(code)
			if v.Pair.Code == "" {
				return errors.New("pairing code required")
			}
		}
	}
	err := request(dir, "POST", "/remote", "", v, out)
	if op != "pair" || (!errors.Is(err, os.ErrNotExist) && !errors.Is(err, syscall.ECONNREFUSED)) {
		return err
	}
	s, err := store.Open(dir)
	if err != nil {
		return err
	}
	defer s.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	scope, err := remote.PairStore(ctx, s, v.Pair)
	if err != nil {
		return err
	}
	return json.NewEncoder(out).Encode(scope)
}
