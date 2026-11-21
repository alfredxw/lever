//go:build unix

package localipc

import (
	"context"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"syscall"
)

func socketPath(dataDir string, create bool) (string, error) {
	id, err := instanceID(dataDir)
	if err != nil {
		return "", err
	}
	// Keep the name short even when the data directory exceeds the socket path limit.
	uid := os.Geteuid()
	dir := filepath.Join("/tmp", fmt.Sprintf("lever-cli-%d", uid))
	if create {
		if err := os.Mkdir(dir, 0700); err != nil && !os.IsExist(err) {
			return "", err
		}
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return "", err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !info.IsDir() || info.Mode().Perm() != 0700 || !ok || int(stat.Uid) != uid {
		return "", fmt.Errorf("Lever CLI directory must be private to the current user: %s", dir)
	}
	return filepath.Join(dir, id+".sock"), nil
}

// Listen is called while the application holds the data directory lock.
func Listen(dataDir string) (net.Listener, error) {
	path, err := socketPath(dataDir, true)
	if err != nil {
		return nil, err
	}
	if info, err := os.Lstat(path); err == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return nil, fmt.Errorf("Lever CLI socket path is already in use: %s", path)
		}
		if err := os.Remove(path); err != nil {
			return nil, err
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	return net.Listen("unix", path)
}

func Dial(ctx context.Context, dataDir string) (net.Conn, error) {
	path, err := socketPath(dataDir, false)
	if err != nil {
		return nil, err
	}
	var dialer net.Dialer
	return dialer.DialContext(ctx, "unix", path)
}
