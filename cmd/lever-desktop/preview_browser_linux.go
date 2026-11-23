package main

import (
	"errors"
	"runtime"

	"github.com/ebitengine/purego"
	"golang.org/x/sys/unix"
)

func openInSystemBrowser(fileURL string) error {
	lib, err := purego.Dlopen("libgio-2.0.so.0", purego.RTLD_LAZY|purego.RTLD_LOCAL)
	if err != nil {
		return err
	}
	defer purego.Dlclose(lib)
	type uriList struct {
		data       *byte
		next, prev *uriList
	}
	var defaultForScheme func(string) uintptr
	var launchURIs func(uintptr, *uriList, uintptr, uintptr) int32
	var unref func(uintptr)
	purego.RegisterLibFunc(&defaultForScheme, lib, "g_app_info_get_default_for_uri_scheme")
	purego.RegisterLibFunc(&launchURIs, lib, "g_app_info_launch_uris")
	purego.RegisterLibFunc(&unref, lib, "g_object_unref")
	browser := defaultForScheme("https")
	if browser == 0 {
		return errors.New("no default web browser configured")
	}
	defer unref(browser)
	data, err := unix.BytePtrFromString(fileURL)
	if err != nil {
		return err
	}
	var pinned runtime.Pinner
	pinned.Pin(data)
	defer pinned.Unpin()
	if launchURIs(browser, &uriList{data: data}, 0, 0) == 0 {
		return errors.New("could not launch the default web browser")
	}
	return nil
}
