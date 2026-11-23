package app

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"net/http"
	"os"

	"lever/internal/model"
	"lever/internal/workspace"
)

const MaxAvatarBytes = 5 << 20

func avatarImageType(data []byte) string {
	switch contentType := http.DetectContentType(data); contentType {
	case "image/png", "image/jpeg", "image/gif", "image/webp":
		return contentType
	}
	return ""
}

func isAvatarImageID(id string) bool {
	if len(id) != 64 {
		return false
	}
	for _, c := range id {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

func avatarUsesColor(kind string) bool {
	switch kind {
	case "monogram", "lucide", "emoji":
		return true
	}
	return false
}

func (a *App) SaveAvatarImage(data []byte) (model.Avatar, error) {
	var avatar model.Avatar
	if len(data) == 0 || len(data) > MaxAvatarBytes {
		return avatar, invalid("Select an image up to 5 MiB")
	}
	if avatarImageType(data) == "" {
		return avatar, invalid("Select a PNG, JPEG, WebP, or GIF image")
	}
	id := fmt.Sprintf("%x", sha256.Sum256(data))
	root, err := os.OpenRoot(a.Store.Dir)
	if err != nil {
		return avatar, err
	}
	defer root.Close()
	if err = root.MkdirAll("avatars", 0700); err != nil {
		return avatar, err
	}
	avatars, err := root.OpenRoot("avatars")
	if err != nil {
		return avatar, err
	}
	defer avatars.Close()
	if err := workspace.CreateFile(avatars, id, data); err != nil && !errors.Is(err, os.ErrExist) {
		return avatar, err
	}
	return model.Avatar{Kind: "image", Value: id}, nil
}

func (a *App) OpenAvatarImage(id string) (*os.File, string, error) {
	if !isAvatarImageID(id) {
		return nil, "", os.ErrNotExist
	}
	root, err := os.OpenRoot(a.Store.Dir)
	if err != nil {
		return nil, "", err
	}
	defer root.Close()
	avatars, err := root.OpenRoot("avatars")
	if err != nil {
		return nil, "", err
	}
	defer avatars.Close()
	f, err := avatars.Open(id)
	if err != nil {
		return nil, "", err
	}
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		f.Close()
		return nil, "", os.ErrNotExist
	}
	var head [512]byte
	n, _ := f.ReadAt(head[:], 0)
	mediaType := avatarImageType(head[:n])
	if mediaType == "" {
		f.Close()
		return nil, "", os.ErrNotExist
	}
	return f, mediaType, nil
}

func (a *App) hasAvatarImage(id string) bool {
	f, _, err := a.OpenAvatarImage(id)
	if err != nil {
		return false
	}
	_ = f.Close()
	return true
}
