package main

import (
	"context"
	"encoding/base64"
	"errors"

	"github.com/egoist/mygo"
)

// NotePDF renders the note's print layout in the calling desktop window.
func (*Dialogs) NotePDF(ctx context.Context) (string, error) {
	page := mygo.CallerPage(ctx)
	if page == nil {
		return "", errors.New("note window is unavailable")
	}
	data, err := page.PrintToPDF(mygo.PDFOptions{PageSize: mygo.PageA4, Background: true})
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(data), nil
}
