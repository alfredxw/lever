package main

import (
	"context"
	"errors"
	"strings"

	"github.com/egoist/mygo"
	_ "github.com/egoist/mygo/locales/zh-Hans"
)

// Appearance applies the workbench's language and theme to native controls.
// Only the desktop's trusted local page can call this bound service.
type Appearance struct{}

func (*Appearance) SetLanguage(language string) error {
	if language != "zh-CN" && language != "en-US" {
		return errors.New("unsupported language")
	}
	mygo.App.SetLocale(language)
	return nil
}

func (*Appearance) SetWindowButtonsTheme(ctx context.Context, dark bool) {
	if window := mygo.CallerWindow(ctx); window != nil {
		theme := mygo.ThemeLight
		if dark {
			theme = mygo.ThemeDark
		}
		window.SetWindowButtonsTheme(theme)
	}
}

type desktopText struct {
	startError, chooseDirectory, checkForUpdates string
}

func nativeText() desktopText {
	if strings.HasPrefix(mygo.App.Locale(), "zh") {
		return desktopText{
			startError:      "无法启动 Lever",
			chooseDirectory: "选择工作目录",
			checkForUpdates: "检查更新…",
		}
	}
	return desktopText{
		startError:      "Unable to start Lever",
		chooseDirectory: "Choose working directory",
		checkForUpdates: "Check for Updates…",
	}
}
