package device

import (
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

func loginPath(dir string) (string, error) {
	home, err := os.UserHomeDir()
	return filepath.Join(home, "Library", "LaunchAgents", loginID(dir)+".plist"), err
}
func LoginEnabled(dir string) bool {
	p, err := loginPath(dir)
	if err != nil {
		return false
	}
	_, err = os.Stat(p)
	return err == nil
}
func SetLogin(dir string, enabled bool) error {
	path, err := loginPath(dir)
	if err != nil {
		return err
	}
	if !enabled {
		err = os.Remove(path)
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	dir, err = filepath.Abs(dir)
	if err != nil {
		return err
	}
	var doc bytes.Buffer
	doc.WriteString(`<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>` + loginID(dir) + `</string><key>RunAtLoad</key><true/><key>ProgramArguments</key><array>`)
	for _, arg := range []string{exe, "--serve-desktop", "--data-dir", dir} {
		doc.WriteString("<string>")
		if err = xml.EscapeText(&doc, []byte(arg)); err != nil {
			return err
		}
		doc.WriteString("</string>")
	}
	doc.WriteString("</array></dict></plist>")
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), "lever-login-")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	_, err = fmt.Fprint(tmp, doc.String())
	err = errors.Join(err, tmp.Close())
	if err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}
