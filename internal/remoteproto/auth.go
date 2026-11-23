package remoteproto

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

func NewID() string { return uuid.NewString() }
func Token() string {
	var b [32]byte
	rand.Read(b[:])
	return base64.RawURLEncoding.EncodeToString(b[:])
}
func Digest(data []byte) string { h := sha256.Sum256(data); return hex.EncodeToString(h[:]) }

func (p PairInput) challenge() []byte {
	p.Proof = nil
	b, _ := json.Marshal(p)
	return append([]byte("lever-pair-v1\n"), b...)
}
func (p *PairInput) Sign(key ed25519.PrivateKey) { p.Proof = ed25519.Sign(key, p.challenge()) }
func (p PairInput) Valid() bool {
	_, err := uuid.Parse(p.ID)
	return err == nil && len(p.PublicKey) == ed25519.PublicKeySize && p.Role.Valid() && len(p.Name) > 0 && len(p.Name) <= 160 && len(p.Platform) <= 64 && ed25519.Verify(p.PublicKey, p.challenge(), p.Proof)
}

func Origin(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.User != nil || u.Hostname() == "" || u.RawQuery != "" || u.Fragment != "" || strings.Trim(u.Path, "/") != "" || (u.Scheme != "https" && !(u.Scheme == "http" && Loopback(u.Hostname()))) {
		return "", errors.New("use an HTTPS Hub origin or HTTP on loopback")
	}
	return u.Scheme + "://" + u.Host, nil
}
func Loopback(name string) bool { return name == "localhost" || net.ParseIP(name).IsLoopback() }

func signedMessage(r *http.Request, body []byte) []byte {
	return []byte(strings.Join([]string{"lever-device-v1", r.Method, r.URL.RequestURI(), r.Header.Get("X-Lever-Time"), r.Header.Get("X-Lever-Nonce"), Digest([]byte(r.Header.Get("Authorization"))), Digest(body)}, "\n"))
}
func Sign(r *http.Request, token string, key ed25519.PrivateKey, body []byte) {
	r.Header.Set("Authorization", "Bearer "+token)
	r.Header.Set("X-Lever-Time", strconv.FormatInt(time.Now().Unix(), 10))
	r.Header.Set("X-Lever-Nonce", NewID())
	r.Header.Set("X-Lever-Signature", base64.RawURLEncoding.EncodeToString(ed25519.Sign(key, signedMessage(r, body))))
}
func Verify(r *http.Request, key ed25519.PublicKey, body []byte, now time.Time) bool {
	ts, err := strconv.ParseInt(r.Header.Get("X-Lever-Time"), 10, 64)
	if err != nil || ts < now.Unix()-60 || ts > now.Unix()+60 || len(r.Header.Get("X-Lever-Nonce")) != 36 || len(key) != ed25519.PublicKeySize {
		return false
	}
	sig, err := base64.RawURLEncoding.DecodeString(r.Header.Get("X-Lever-Signature"))
	return err == nil && ed25519.Verify(key, signedMessage(r, body), sig)
}

var Client = &http.Client{Timeout: 20 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

func Exchange(client *http.Client, r *http.Request, out any) error {
	resp, err := client.Do(r)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return &HTTPError{resp.StatusCode, strings.TrimSpace(string(b))}
	}
	if out == nil {
		_, err = io.Copy(io.Discard, resp.Body)
		return err
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

type HTTPError struct {
	Status  int
	Message string
}

func (e *HTTPError) Error() string { return fmt.Sprintf("Hub HTTP %d: %s", e.Status, e.Message) }
func Decode(data []byte, v any) error {
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		return err
	}
	if d.Decode(new(any)) != io.EOF {
		return errors.New("unexpected trailing JSON")
	}
	return nil
}
