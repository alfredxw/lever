package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"golang.org/x/crypto/acme"
	"golang.org/x/crypto/acme/autocert"
	"golang.org/x/term"
	"lever/internal/hub"
	"lever/web/hubassets"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run(args []string) error {
	op := "serve"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		op = args[0]
		args = args[1:]
	}
	fs := flag.NewFlagSet("lever-hub "+op, flag.ContinueOnError)
	defaultDir := os.Getenv("LEVER_HUB_DATA_DIR")
	if defaultDir == "" {
		base, err := os.UserConfigDir()
		if err != nil {
			return err
		}
		defaultDir = filepath.Join(base, "LeverHub")
	}
	dir := fs.String("data-dir", defaultDir, "Hub data directory")
	user := fs.String("user", "admin", "administrator name")
	output := fs.String("o", "", "new backup tar.gz")
	domain := fs.String("tls-domain", os.Getenv("LEVER_HUB_DOMAIN"), "ACME TLS-ALPN domain")
	listen := fs.String("listen", "", "HTTP bind address (default 127.0.0.1:8090, or :443 for TLS)")
	stdin := fs.Bool("password-stdin", false, "read administrator password from stdin")
	if err := fs.Parse(args); err != nil {
		return err
	}
	switch op {
	case "backup":
		if *output == "" {
			return errors.New("backup requires -o PATH")
		}
		return hub.Backup(*dir, *output)
	case "restore":
		if fs.NArg() != 1 {
			return errors.New("restore requires one backup path")
		}
		return hub.Restore(*dir, fs.Arg(0))
	case "setup", "reset-password":
		var pw string
		if !*stdin && term.IsTerminal(int(os.Stdin.Fd())) {
			fmt.Fprint(os.Stderr, "Administrator password: ")
			b, err := term.ReadPassword(int(os.Stdin.Fd()))
			fmt.Fprintln(os.Stderr)
			if err != nil {
				return err
			}
			pw = string(b)
		} else {
			scan := bufio.NewScanner(os.Stdin)
			if !scan.Scan() {
				return errors.New("read password from stdin")
			}
			pw = scan.Text()
		}
		if op == "reset-password" {
			return hub.ResetPassword(*dir, *user, pw)
		}
		h, err := hub.Open(*dir)
		if err != nil {
			return err
		}
		defer h.Close()
		return h.Setup(*user, pw)
	case "serve":
	default:
		return fmt.Errorf("unknown subcommand %q", op)
	}
	h, err := hub.Open(*dir)
	if err != nil {
		return err
	}
	defer h.Close()
	if *listen == "" {
		*listen = "127.0.0.1:8090"
		if *domain != "" {
			*listen = ":443"
		}
	}
	server := &http.Server{Addr: *listen, Handler: h.Handler(hubassets.Assets()), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 32 << 10}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := h.ConfigurePush(ctx, os.Getenv("LEVER_HUB_PUSH_CONFIG")); err != nil {
		return err
	}
	pushDone := make(chan struct{})
	go func() { defer close(pushDone); h.RunPush(ctx) }()
	defer func() { stop(); <-pushDone }()
	ended := make(chan error, 1)
	go func() {
		if *domain != "" {
			manager := autocert.Manager{Prompt: autocert.AcceptTOS, HostPolicy: autocert.HostWhitelist(*domain), Cache: autocert.DirCache(filepath.Join(*dir, "tls"))}
			server.TLSConfig = &tls.Config{MinVersion: tls.VersionTLS12, GetCertificate: manager.GetCertificate, NextProtos: []string{"h2", "http/1.1", acme.ALPNProto}}
			ended <- server.ListenAndServeTLS("", "")
		} else {
			ended <- server.ListenAndServe()
		}
	}()
	fmt.Fprintln(os.Stderr, "Lever Hub listening on", *listen)
	select {
	case err = <-ended:
		return err
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
		return nil
	}
}
