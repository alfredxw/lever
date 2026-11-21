package provider

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
)

// Pinned official ACP Registry release. Download verification precedes extraction
// and publication; an incomplete download can never replace a usable runtime.
const antigravityVersion = "1.4.5"

type antigravityRelease struct {
	URL, SHA256                                 string
	ArchiveBytes, ExecutableBytes, HarnessBytes int64
}

var antigravityReleases = map[string]antigravityRelease{
	"darwin-arm64":  {"https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.5-darwin-arm64.zip", "886fff7767d08994ca39eb02c3d01a7532c7325a94aa33aaf52d52068733284f", 97923855, 178915920, 122957936},
	"darwin-amd64":  {"https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.5-darwin-x86_64.zip", "b39f3573c03b9acb9df028853f647527f1f3133f32bd77e78b796e48a205114a", 103577295, 183127600, 127612208},
	"linux-amd64":   {"https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.5-linux-x86_64.zip", "923923a0d7dc8073f66cc6f78647a3107e3a7ee2b7e1a24df8b3927b5188013b", 321783181, 826226766, 133926136},
	"linux-arm64":   {"https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.5-linux-arm64.zip", "7d64246633ae094f67e3bbcd2d679e89048f91346d5339313336e7483f40f056", 307829008, 831194025, 127512832},
	"windows-amd64": {"https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.5-windows-x86_64.zip", "d24f4c73c9f96d4f44384e281c855a56c72d8eaa9c5b0fad7ccb1635c6b63f50", 100423655, 55839864, 147843736},
	"windows-arm64": {"https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.5-windows-arm64.zip", "ab0a9aac8349e08ef289be6d16da8f89e3abe60eba5158032ef78c4a1220261c", 102703121, 62293488, 139322008},
}

func InstallAntigravity(ctx context.Context) error {
	release, ok := antigravityReleases[runtime.GOOS+"-"+runtime.GOARCH]
	if !ok {
		return errors.New("No managed Antigravity runtime is available for this platform")
	}
	return installAntigravity(ctx, release)
}

func antigravityInstalled(dir string, release antigravityRelease) bool {
	name, harness := antigravityNames()
	for file, size := range map[string]int64{name: release.ExecutableBytes, harness: release.HarnessBytes} {
		info, err := os.Lstat(filepath.Join(dir, file))
		if err != nil || !info.Mode().IsRegular() || info.Size() != size || (runtime.GOOS != "windows" && info.Mode()&0111 == 0) {
			return false
		}
	}
	return true
}

func installAntigravity(ctx context.Context, release antigravityRelease) error {
	dir, err := antigravityInstallDir(ctx)
	if err != nil {
		return err
	}
	if antigravityInstalled(dir, release) {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(dir), 0700); err != nil {
		return err
	}
	stage, err := os.MkdirTemp(filepath.Dir(dir), ".install-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, release.URL, nil)
	if err != nil {
		return err
	}
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("Download Antigravity: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("Download Antigravity: HTTP %d", response.StatusCode)
	}
	archive := filepath.Join(stage, "runtime.zip")
	out, err := os.OpenFile(archive, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	digest := sha256.New()
	size, copyErr := io.Copy(io.MultiWriter(out, digest), io.LimitReader(response.Body, release.ArchiveBytes+1))
	if err := errors.Join(copyErr, out.Close()); err != nil {
		return err
	}
	if size != release.ArchiveBytes || hex.EncodeToString(digest.Sum(nil)) != release.SHA256 {
		return errors.New("Antigravity download failed size or SHA-256 verification")
	}
	if err := extractAntigravity(ctx, archive, stage, release); err != nil {
		return err
	}
	if err := os.Remove(archive); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if _, err := os.Lstat(dir); err == nil {
		backup := stage + "-incomplete"
		if err := os.Rename(dir, backup); err != nil {
			return err
		}
		if err := os.Rename(stage, dir); err != nil {
			_ = os.Rename(backup, dir)
			return err
		}
		return os.RemoveAll(backup)
	}
	return os.Rename(stage, dir)
}

func extractAntigravity(ctx context.Context, archive, dir string, release antigravityRelease) error {
	z, err := zip.OpenReader(archive)
	if err != nil {
		return err
	}
	defer z.Close()
	name, harness := antigravityNames()
	wanted := map[string]int64{name: release.ExecutableBytes, harness: release.HarnessBytes}
	for _, file := range z.File {
		// Extract only the two expected regular files, never archive paths or links.
		size, ok := wanted[file.Name]
		if !ok {
			continue
		}
		if !file.Mode().IsRegular() || file.UncompressedSize64 != uint64(size) {
			return errors.New("Antigravity archive contains an invalid executable")
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		input, err := file.Open()
		if err != nil {
			return err
		}
		output, err := os.OpenFile(filepath.Join(dir, file.Name), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0700)
		if err != nil {
			input.Close()
			return err
		}
		n, copyErr := io.Copy(output, io.LimitReader(input, size+1))
		err = errors.Join(copyErr, input.Close(), output.Close())
		if err != nil {
			return err
		}
		if n != size {
			return errors.New("Antigravity executable has an invalid size")
		}
		delete(wanted, file.Name)
	}
	if len(wanted) != 0 {
		return errors.New("Antigravity archive is missing its ACP executable or harness")
	}
	return nil
}
