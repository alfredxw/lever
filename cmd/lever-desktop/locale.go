package main

import (
	"errors"
	"strings"

	"github.com/egoist/mygo"
	_ "github.com/egoist/mygo/locales/zh-Hans"
)

// Appearance keeps native menus and dialogs in the language chosen in the Web UI.
// Only the desktop's trusted local page can call this bound service.
type Appearance struct{}

func (*Appearance) SetLanguage(language string) error {
	if language != "zh-CN" && language != "en-US" {
		return errors.New("unsupported language")
	}
	mygo.App.SetLocale(language)
	return nil
}

type desktopText struct {
	startError, chooseDirectory string
}

func nativeText() desktopText {
	if strings.HasPrefix(mygo.App.Locale(), "zh") {
		return desktopText{startError: "无法启动 Lever", chooseDirectory: "选择工作目录"}
	}
	return desktopText{startError: "Unable to start Lever", chooseDirectory: "Choose working directory"}
}
