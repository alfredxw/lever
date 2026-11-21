package main

import (
	"errors"

	"github.com/ebitengine/purego/objc"
	"github.com/egoist/mygo"
)

const browserAppearanceAvailable = true

func nativeBrowserPages(win *mygo.Window) []uintptr {
	var pages []uintptr
	webClass := objc.GetClass("WKWebView")
	var visit func(objc.ID)
	visit = func(view objc.ID) {
		if objc.Send[bool](view, objc.RegisterName("isKindOfClass:"), webClass) {
			pages = append(pages, uintptr(view))
			return
		}
		children := view.Send(objc.RegisterName("subviews"))
		for index := range uintptr(children.Send(objc.RegisterName("count"))) {
			visit(children.Send(objc.RegisterName("objectAtIndex:"), index))
		}
	}
	visit(objc.ID(win.NativeHandle()).Send(objc.RegisterName("contentView")))
	return pages
}

func setBrowserAppearance(handle uintptr, scheme string) error {
	if handle == 0 {
		return errors.New("cannot locate the native browser page")
	}
	var appearance objc.ID
	if scheme != "system" {
		name := "NSAppearanceNameAqua"
		if scheme == "dark" {
			name = "NSAppearanceNameDarkAqua"
		}
		nativeName := objc.ID(objc.GetClass("NSString")).Send(objc.RegisterName("stringWithUTF8String:"), name)
		appearance = objc.ID(objc.GetClass("NSAppearance")).Send(objc.RegisterName("appearanceNamed:"), nativeName)
	}
	objc.ID(handle).Send(objc.RegisterName("setAppearance:"), appearance)
	return nil
}
