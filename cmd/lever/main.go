package main

import (
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
	dir := flag.String("data-dir", host.DefaultDir(), "Local data directory")
	address := flag.String("listen", "127.0.0.1:4778", "Loopback listen address")
	devOrigin := flag.String("dev-origin", "", "Allowed Vite development origin")
	flag.Usage = func() {
		fmt.Fprintln(os.Stderr, cli.UsageText)
		flag.PrintDefaults()
	}
	flag.Parse()
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
