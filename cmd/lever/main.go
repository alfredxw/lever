package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"lever/internal/cli"
	"lever/internal/host"
	"lever/internal/provider"
	"lever/internal/runhost"
)

func main() {
	if runhost.Main() {
		return
	}
	if provider.AntigravityBrowserHelper() {
		return
	}
	if provider.MCPStdioHelper() {
		return
	}
	background := flag.Bool(host.DesktopServerFlag, false, "Run the paired Host without a window")
	dir := flag.String("data-dir", host.DefaultDir(), "Local data directory")
	address := flag.String("listen", "127.0.0.1:4778", "Loopback listen address")
	devOrigin := flag.String("dev-origin", "", "Allowed Vite development origin")
	flag.Usage = func() {
		fmt.Fprintln(os.Stderr, cli.UsageText)
		flag.PrintDefaults()
	}
	flag.Parse()
	if flag.Arg(0) == "serve" {
		if err := serveNode(flag.Args()[1:], *dir); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	if *background {
		ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer cancel()
		if err := host.ServeDesktop(ctx, *dir, *address, *devOrigin, os.Stdout); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	if handled, err := cli.Run(flag.Args(), *dir, os.Stdout, os.Stderr); handled {
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	server, err := host.Start(*dir, *address, *devOrigin)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Println("Lever:", server.PairURL())
	if *devOrigin != "" {
		fmt.Println("Development:", *devOrigin+"/#token="+server.Token)
	}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	<-signals
	if err = host.Stop(server); err != nil {
		fmt.Fprintln(os.Stderr, err)
	}
}

func serveNode(args []string, dir string) error {
	if os.Getenv("LEVER_EXECUTION_TOKEN") != "" {
		return errors.New("starting a Node requires a local operator")
	}
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	fs.StringVar(&dir, "data-dir", dir, "Node data directory")
	bind := fs.String("listen", "127.0.0.1:8090", "peer TLS listener address")
	advertise := fs.String("advertise", "", "peer address advertised in pairing links")
	jsonReady := fs.Bool("json", false, "emit one versioned JSON readiness record")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 0 {
		return errors.New("unexpected serve argument")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	server, err := host.Start(dir, "127.0.0.1:0", "")
	if err != nil {
		return err
	}
	addr, err := server.Remote.ListenPeer(*bind, *advertise)
	if err != nil {
		return errors.Join(err, host.Stop(server))
	}
	if *jsonReady {
		err = json.NewEncoder(os.Stdout).Encode(map[string]any{"version": 1, "ready": true, "nodeId": server.App.Store.DeviceID, "listen": *bind, "advertise": addr})
	} else {
		_, err = fmt.Fprintln(os.Stdout, "Lever Node", server.App.Store.DeviceID, addr)
	}
	if err == nil {
		<-ctx.Done()
	}
	return errors.Join(err, host.Stop(server))
}
