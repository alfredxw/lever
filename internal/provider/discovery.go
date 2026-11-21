package provider

import (
	"context"
	"errors"
	"fmt"
	"time"

	"lever/internal/device"
	"lever/internal/model"
)

type nativeClient struct {
	path    string
	initial object
	send    func(string, object) (string, error)
	next    func() (object, error)
	call    func(string, object) (object, error)
	close   func()
}

// Discovery uses initialization and read-only runtime requests, never a model turn.
func openDiscovery(ctx context.Context, config model.Provider, cwd string, options []string) (*nativeClient, error) {
	return openNativeClient(ctx, config, cwd, options, 15*time.Second)
}

func openNativeClient(ctx context.Context, config model.Provider, cwd string, options []string, timeout time.Duration) (*nativeClient, error) {
	id := config.Type
	if id != "codex" && id != "claude" {
		return nil, errors.New("unsupported runtime")
	}
	path, err := Executable(ctx, config)
	if err != nil {
		return nil, err
	}
	cmd := codexCommand(path, config)
	if id == "claude" {
		if len(options) == 0 {
			options = []string{"--settings", `{"disableAllHooks":true,"fastMode":true}`}
		}
		cmd = device.Command(path, config.Args...)
		cmd.Args = append(cmd.Args, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose")
	}
	cmd.Args = append(cmd.Args, options...)
	if err := applyProfile(cmd, config); err != nil {
		return nil, err
	}
	cmd.Dir = cwd
	p, err := device.Start(cmd)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	p.Watch(ctx, func() {})
	d := &nativeClient{path: path, close: func() { cancel(); p.Close() }}
	d.next = func() (object, error) {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case b, ok := <-p.Frames:
			if !ok {
				return nil, errors.Join(errors.New("runtime connection closed"), p.Error())
			}
			return decode(b)
		}
	}
	sequence := 0
	d.send = func(method string, params object) (string, error) {
		sequence++
		requestID := fmt.Sprintf("discovery-%d", sequence)
		frame := object{"id": requestID, "method": method, "params": params}
		if id == "claude" {
			params["subtype"] = method
			frame = object{"type": "control_request", "request_id": requestID, "request": params}
		}
		return requestID, p.Send(frame)
	}
	d.call = func(method string, params object) (object, error) {
		requestID, err := d.send(method, params)
		if err != nil {
			return nil, err
		}
		for {
			f, err := d.next()
			if err != nil {
				return nil, err
			}
			if id == "claude" && str(f["type"]) == "control_response" {
				r := obj(f["response"])
				if str(r["request_id"]) == requestID {
					if str(r["subtype"]) != "success" {
						return nil, fail(r)
					}
					return obj(r["response"]), nil
				}
			}
			if str(f["id"]) == requestID && f["method"] == nil {
				if f["error"] != nil {
					return nil, fail(f["error"])
				}
				return obj(f["result"]), nil
			}
		}
	}
	params := object{"hooks": object{}}
	if id == "codex" {
		params = object{"clientInfo": object{"name": "lever", "version": "0.1.0"}, "capabilities": object{"experimentalApi": true}}
	}
	d.initial, err = d.call("initialize", params)
	if err == nil && id == "codex" {
		err = p.Send(object{"method": "initialized"})
	}
	if err != nil {
		d.close()
		return nil, err
	}
	return d, nil
}
