package provider

import (
	"context"
	"errors"
	"os"
	"path/filepath"

	"lever/internal/model"
)

func antigravityAuthMethod(config model.Provider) string {
	if config.AuthMethod != "" {
		return config.AuthMethod
	}
	return "oauth-personal"
}

func antigravityKeyPath(ctx context.Context, id string) (string, error) {
	dir, err := antigravityDir(ctx)
	if err != nil {
		return "", err
	}
	return filepath.Join(antigravityProfileDir(dir, id), "api-key"), nil
}

// SetAntigravityKey replaces the write-only credential independently of the
// public provider configuration. Running processes keep their original key.
func SetAntigravityKey(ctx context.Context, id, key string) error {
	path, err := antigravityKeyPath(ctx, id)
	if err != nil {
		return err
	}
	if key == "" {
		if err := os.Remove(path); !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return nil
	}
	return writeProfileFile(path, []byte(key))
}

func writeProfileFile(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".profile-")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	_, err = tmp.Write(data)
	if err := errors.Join(err, tmp.Close()); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

func antigravityCredential(ctx context.Context, config model.Provider) (string, error) {
	if config.AuthMethod != "gemini-api-key" && config.AuthMethod != "agent-platform" {
		return "", nil
	}
	path, err := antigravityKeyPath(ctx, config.ID)
	if err != nil {
		return "", err
	}
	value, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	if len(value) == 0 {
		if config.AuthMethod == "agent-platform" && config.GCPProject != "" && config.GCPLocation != "" {
			return "", nil
		}
		return "", errors.New("Set an API key in provider settings")
	}
	if config.AuthMethod == "agent-platform" {
		return "GOOGLE_API_KEY=" + string(value), nil
	}
	return "GEMINI_API_KEY=" + string(value), nil
}
