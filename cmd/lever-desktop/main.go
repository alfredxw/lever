package main

import (
	"context"
	_ "embed"
	"flag"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
	"lever/internal/cli"
	"lever/internal/host"
	"lever/internal/provider"
	"lever/internal/runhost"
	"lever/internal/store"
)

//go:embed icon.png
var appIcon []byte

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
	generate := os.Getenv("MYGO_GENERATE") != ""
	var dir, address, devOrigin *string
	var freshBackend, reloadOnSighup bool
	if !generate {
		dir = flag.String("data-dir", host.DefaultDir(), "Local data directory")
		printDir := flag.Bool("print-data-dir", false, "Print the effective data directory and exit")
		printRestartBusy := flag.Bool("print-restart-busy", false, "Print whether active runs need the current desktop backend")
		address = flag.String("listen", "127.0.0.1:4778", "Stable loopback origin for desktop preferences")
		devOrigin = flag.String("dev-origin", "", "Vite development origin for frontend hot updates")
		flag.BoolVar(&freshBackend, "fresh-backend", false, "Start the backend from this executable when restarting the desktop")
		flag.BoolVar(&reloadOnSighup, "reload-on-sighup", false, "Reload the desktop frontend on SIGHUP")
		serve := flag.Bool(host.DesktopServerFlag, false, "Run the desktop's local backend without a window")
		flag.Parse()
		if *printDir {
			fmt.Println(filepath.Clean(*dir))
			return
		}
		if *printRestartBusy {
			busy, err := store.DesktopRestartBusy(*dir)
			if err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
			fmt.Println(busy)
			return
		}
		if *serve {
			ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
			err := host.ServeDesktop(ctx, *dir, *address, *devOrigin, os.Stdout)
			stop()
			if err != nil {
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
	}
	mygo.App.SetName("Lever")
	mygo.App.SetLanguages("en-US", "zh-CN")
	notifications := &Notifications{}
	dialogs := &Dialogs{}
	browser := &Browser{tabs: make(map[string]*browserTab)}
	mygo.Bind(&Appearance{}, dialogs, notifications, browser)
	// Binding generation must not open the user's database or start a server.
	if generate {
		if err := mygo.App.Run(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	backend, err := host.ConnectDesktop(*dir, *address, *devOrigin, freshBackend)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		if freshBackend {
			os.Exit(1)
		}
		mygo.App.WhenReady(func() {
			go func() {
				_, _ = mygo.Dialog.Message(mygo.MessageOptions{Type: mygo.MessageError, Title: "Lever", Message: nativeText().startError, Detail: err.Error()})
				mygo.App.Quit()
			}()
		})
		_ = mygo.App.Run()
		return
	}
	defer backend.Close()
	if *devOrigin != "" {
		fmt.Println("Lever Desktop:", backend.URL)
	}
	if reloadOnSighup {
		reload := make(chan os.Signal, 1)
		signal.Notify(reload, syscall.SIGHUP)
		defer func() {
			signal.Stop(reload)
			close(reload)
		}()
		go func() {
			for range reload {
				mygo.RunOnMain(func() {
					if shell := browser.shell; shell != nil && !shell.IsDestroyed() {
						shell.Page().ReloadIgnoringCache()
					}
				})
			}
		}()
	}
	logFile, logErr := os.OpenFile(filepath.Join(*dir, "desktop.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if logErr == nil {
		defer logFile.Close()
		slog.SetDefault(slog.New(slog.NewTextHandler(logFile, nil)))
	}
	mygo.App.SetVersion("0.1.0")
	mygo.App.OnNotificationClick(notifications.open)
	mygo.App.WhenReady(func() {
		options := mygo.WindowOptions{
			Title:     "Lever",
			Width:     1320,
			Height:    860,
			MinWidth:  680,
			MinHeight: 500,
			StateKey:  "main",
			Content:   ui.View(browser.paint),
		}
		if runtime.GOOS == "darwin" {
			mygo.App.SetMenu(mygo.NewMenu([]*mygo.MenuItem{
				{Role: mygo.RoleAppMenu},
				{Role: mygo.RoleFileMenu, Submenu: []*mygo.MenuItem{
					{Role: mygo.RoleClose, Accelerator: "Cmd+Shift+W"},
				}},
				{Role: mygo.RoleEditMenu},
				{Role: mygo.RoleViewMenu},
				{Role: mygo.RoleWindowMenu},
			}))
			if err := mygo.App.Dock.SetIcon(appIcon); err != nil {
				slog.Warn("set app icon", "error", err)
			}
			options.TitleBarStyle = mygo.TitleBarHidden
			options.TrafficLightPosition = &mygo.Point{X: 12, Y: 17}
			options.TitleBarHeight = 48
		} else if runtime.GOOS == "windows" {
			options.TitleBarStyle = mygo.TitleBarHidden
			options.TitleBarHeight = 40
			options.AutoHideMenuBar = true
		}
		window := mygo.NewWindow(options)
		if err := browser.attach(window, backend.URL, backend.PairURL); err != nil {
			slog.Error("load workbench", "error", err)
			mygo.App.Quit()
		}
	})
	mygo.App.OnWindowAllClosed(func() { mygo.App.Quit() })
	if err = mygo.App.Run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
	}
}

func (browser *Browser) attach(window *mygo.Window, origin, start string) error {
	shell, err := window.NewWebView(mygo.WebViewOptions{Page: mygo.PageOptions{TrustedOrigins: []string{origin}}})
	if err != nil {
		return err
	}
	browser.shell = shell
	unregisterSurfaceDraggedTypes(window)
	window.Invalidate()
	page := shell.Page()
	page.OnDOMReady(func() {
		if browser.frame != nil {
			_ = frameChanged.EmitPage(page, *browser.frame)
		}
	})
	page.SetPermissionHandler(func(mygo.PermissionRequest) bool { return false })
	page.OnDidFailLoad(func(e *mygo.LoadError) {
		slog.Error("desktop page failed", "code", e.Code, "description", e.Description)
	})
	page.OnDidFinishLoad(func() { slog.Info("desktop page loaded") })
	external := func(raw string) {
		u, err := url.Parse(raw)
		if err == nil && (u.Scheme == "https" || u.Scheme == "http") {
			_ = mygo.Shell.OpenExternal(raw)
		}
	}
	page.SetWindowOpenHandler(func(request mygo.WindowOpenRequest) *mygo.WindowOptions { external(request.URL); return nil })
	page.OnWillNavigate(func(event *mygo.NavigateEvent) {
		u, err := url.Parse(event.URL)
		base, _ := url.Parse(origin)
		if err != nil || u.Scheme != base.Scheme || u.Host != base.Host {
			event.PreventDefault()
			external(event.URL)
		}
	})
	page.OnDidNavigate(func(string) { browser.reset() })
	window.OnClosed(browser.reset)
	return page.LoadURL(start)
}
