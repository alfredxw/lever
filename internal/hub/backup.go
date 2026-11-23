package hub

import (
	"archive/tar"
	"compress/gzip"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

func Backup(dir, output string) error {
	if _, err := os.Stat(filepath.Join(dir, "hub.db")); err != nil {
		return err
	}
	stage, err := os.MkdirTemp(dir, "backup-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	db, err := database(dir)
	if err != nil {
		return err
	}
	defer db.Close()
	snap := filepath.Join(stage, "hub.db")
	if _, err = db.Exec("VACUUM INTO ?", snap); err != nil {
		return err
	}
	identity := filepath.Join(dir, "identity", "hub.json")
	if err = checkSnapshot(snap, identity); err != nil {
		return err
	}
	out, err := os.OpenFile(output, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	ok := false
	defer func() {
		out.Close()
		if !ok {
			os.Remove(output)
		}
	}()
	gz := gzip.NewWriter(out)
	tw := tar.NewWriter(gz)
	for _, v := range []struct{ name, path string }{{"hub.db", snap}, {"identity/hub.json", identity}} {
		f, err := os.Open(v.path)
		if err != nil {
			return err
		}
		info, err := f.Stat()
		if err == nil {
			err = tw.WriteHeader(&tar.Header{Name: v.name, Mode: 0600, Size: info.Size(), Typeflag: tar.TypeReg})
		}
		if err == nil {
			_, err = io.Copy(tw, f)
		}
		f.Close()
		if err != nil {
			return err
		}
	}
	if err = tw.Close(); err != nil {
		return err
	}
	if err = gz.Close(); err != nil {
		return err
	}
	if err = out.Sync(); err != nil {
		return err
	}
	if err = out.Close(); err != nil {
		return err
	}
	ok = true
	return nil
}
func checkSnapshot(path, identity string) error {
	raw, err := os.ReadFile(identity)
	if err != nil {
		return err
	}
	id, err := parseIdentity(raw)
	if err != nil {
		return err
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return err
	}
	defer db.Close()
	var v int
	var integrity, hubID string
	if err = db.QueryRow("PRAGMA user_version").Scan(&v); err != nil || v != 1 {
		return errors.New("incompatible Hub database")
	}
	if err = db.QueryRow("PRAGMA integrity_check").Scan(&integrity); err != nil || integrity != "ok" {
		return errors.New("invalid Hub database")
	}
	if err = db.QueryRow("SELECT id FROM hub_identity").Scan(&hubID); err != nil || hubID != id.ID {
		return errors.New("backup identity does not match database")
	}
	return nil
}
func Restore(dir, input string) error {
	lock, err := directoryLock(dir)
	if err != nil {
		return err
	}
	defer lock.Unlock()
	if err = finishRestore(dir); err != nil {
		return err
	}
	var source io.Reader = os.Stdin
	if input != "-" {
		f, err := os.Open(input)
		if err != nil {
			return err
		}
		defer f.Close()
		source = f
	}
	gz, err := gzip.NewReader(source)
	if err != nil {
		return err
	}
	defer gz.Close()
	stage, err := os.MkdirTemp(dir, "restore-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	tr := tar.NewReader(gz)
	seen := map[string]bool{}
	for {
		header, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return err
		}
		name := header.Name
		if (name != "hub.db" && name != "identity/hub.json") || header.Typeflag != tar.TypeReg || seen[name] || header.Size > 32<<30 || (name == "identity/hub.json" && header.Size > 4096) {
			return fmt.Errorf("invalid backup entry %q", name)
		}
		seen[name] = true
		path := filepath.Join(stage, filepath.Base(name))
		out, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			return err
		}
		_, err = io.CopyN(out, tr, header.Size)
		err = errors.Join(err, out.Sync(), out.Close())
		if err != nil {
			return err
		}
	}
	if _, err = io.Copy(io.Discard, gz); err != nil {
		return err
	}
	if err = checkSnapshot(filepath.Join(stage, "hub.db"), filepath.Join(stage, "hub.json")); err != nil {
		return err
	}
	if err = os.Rename(stage, filepath.Join(dir, "restore-pending")); err != nil {
		return err
	}
	return finishRestore(dir)
}

// The staged directory is a recovery marker. Opening after an interrupted
// restore installs both verified files again before any SQLite connection opens.
func finishRestore(dir string) error {
	stage := filepath.Join(dir, "restore-pending")
	if _, err := os.Stat(stage); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(dir, "identity"), 0700); err != nil {
		return err
	}
	for _, suffix := range []string{"-wal", "-shm"} {
		if err := os.Remove(filepath.Join(dir, "hub.db") + suffix); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	for _, name := range []string{"hub.db", "identity/hub.json"} {
		src, err := os.Open(filepath.Join(stage, filepath.Base(name)))
		if err != nil {
			return err
		}
		dst := filepath.Join(dir, name)
		tmp, err := os.CreateTemp(filepath.Dir(dst), "install-")
		if err != nil {
			src.Close()
			return err
		}
		_, err = io.Copy(tmp, src)
		err = errors.Join(err, src.Close(), tmp.Sync(), tmp.Close())
		if err == nil {
			err = os.Rename(tmp.Name(), dst)
		}
		if err != nil {
			os.Remove(tmp.Name())
			return err
		}
	}
	return os.RemoveAll(stage)
}
