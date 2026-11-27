package main

import (
	"context"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/transfer"
	"lever/internal/workspace"
)

type Dialogs struct{}

func (*Dialogs) ShowAbout() {
	version := mygo.App.Version()
	if version == "" {
		version = "dev"
	}
	mygo.App.ShowAboutPanel(mygo.AboutPanelOptions{
		ApplicationName: mygo.App.Name(), ApplicationVersion: version,
	})
}

func (*Dialogs) OpenPreviewInBrowser(path, fragment string) error {
	link, err := htmlFileURL(path, fragment)
	if err != nil {
		return err
	}
	return openInSystemBrowser(link)
}

func htmlFileURL(path, fragment string) (string, error) {
	ext := strings.ToLower(filepath.Ext(path))
	local := filepath.ToSlash(path)
	if !filepath.IsAbs(path) || strings.HasPrefix(local, "//") || (ext != ".html" && ext != ".htm") {
		return "", errors.New("expected a local HTML file")
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() {
		return "", errors.New("expected a regular HTML file")
	}
	link, err := url.Parse(fragment)
	if err != nil || (fragment != "" && !strings.HasPrefix(fragment, "#")) {
		return "", errors.New("invalid HTML fragment")
	}
	link.Scheme, link.Path = "file", "/"+strings.TrimPrefix(local, "/")
	return link.String(), nil
}

type ContextMenuItem struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	Disabled bool   `json:"disabled,omitempty"`
}

// ShowContextMenu returns the chosen action, or an empty string on dismissal.
// Empty IDs separate groups. Menu.PopupAt waits until the native menu closes.
func (*Dialogs) ShowContextMenu(ctx context.Context, items []ContextMenuItem, x, y int) string {
	selected := ""
	menu := make([]*mygo.MenuItem, 0, len(items))
	for _, item := range items {
		if item.ID == "" {
			menu = append(menu, mygo.Separator())
			continue
		}
		menu = append(menu, &mygo.MenuItem{
			ID: item.ID, Label: item.Label, Disabled: item.Disabled,
			Click: func(item *mygo.MenuItem, _ *mygo.Window) { selected = item.ID },
		})
	}
	mygo.NewMenu(menu).PopupAt(mygo.CallerWindow(ctx), x, y)
	return selected
}

func (*Dialogs) OpenPath(path string) error {
	return mygo.Shell.OpenPath(path)
}

func (*Dialogs) WriteClipboard(text, markup string) error {
	data := transfer.TextData(text)
	if markup != "" {
		data = transfer.New(transfer.NewItem(
			transfer.Bytes(transfer.Text, []byte(text)),
			transfer.Bytes(transfer.HTML, []byte(markup)),
		))
	}
	return mygo.Clipboard.Write(data)
}

func (*Dialogs) OpenDirectory(path string) error {
	directory, err := workspace.Canonical(path)
	if err != nil {
		return err
	}
	return mygo.Shell.OpenPath(directory)
}

func (*Dialogs) ShowItemInFolder(path string) error {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	if _, err := os.Stat(absolute); err != nil {
		return err
	}
	mygo.Shell.ShowItemInFolder(absolute)
	return nil
}

func (*Dialogs) PickDirectories(ctx context.Context, defaultPath string, multiple bool) ([]string, error) {
	paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{
		Parent:            mygo.CallerWindow(ctx),
		Title:             nativeText().chooseDirectory,
		DefaultPath:       defaultPath,
		Directory:         true,
		Multiple:          multiple,
		CreateDirectories: true,
	})
	if paths == nil {
		paths = []string{}
	}
	return paths, err
}
