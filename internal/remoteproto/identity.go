package remoteproto

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

type LANIdentity struct {
	Identity
	Name     string `json:"name"`
	Platform string `json:"platform"`
}

func Fingerprint(key []byte) string {
	sum := Digest(key)[:32]
	groups := make([]string, 0, 8)
	for i := 0; i < len(sum); i += 4 {
		groups = append(groups, sum[i:i+4])
	}
	return strings.Join(groups, " ")
}

func PeerCertificate(cs tls.ConnectionState, expected []byte) (ed25519.PublicKey, error) {
	if len(cs.PeerCertificates) == 1 {
		leaf := cs.PeerCertificates[0]
		key, ok := leaf.PublicKey.(ed25519.PublicKey)
		now := time.Now()
		if ok && (expected == nil || bytes.Equal(key, expected)) && !now.Before(leaf.NotBefore) && now.Before(leaf.NotAfter) && leaf.CheckSignature(x509.PureEd25519, leaf.RawTBSCertificate, leaf.Signature) == nil {
			return key, nil
		}
	}
	return nil, errors.New("Host identity mismatch")
}

// ProbeLANIdentity makes an anonymous request. PairDirect will only transmit
// a short code after the user has confirmed this key on the Owner.
func ProbeLANIdentity(ctx context.Context, address string) (LANIdentity, error) {
	var out LANIdentity
	host, port, err := net.SplitHostPort(address)
	n, e := strconv.Atoi(port)
	if err != nil || net.ParseIP(host) == nil || e != nil || n < 1 || n > 65535 {
		return out, errors.New("请输入 IP:Port 地址")
	}
	client := http.Client{Timeout: 3 * time.Second, CheckRedirect: Client.CheckRedirect, Transport: &http.Transport{
		DisableKeepAlives: true, TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS13, InsecureSkipVerify: true, VerifyConnection: func(cs tls.ConnectionState) error { _, err := PeerCertificate(cs, nil); return err }},
	}}
	req, err := http.NewRequestWithContext(ctx, "GET", "https://"+address+"/identity", nil)
	if err != nil {
		return out, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return out, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 || resp.TLS == nil {
		return out, errors.New("此设备暂不支持地址配对，请使用二维码或更新 Lever")
	}
	if err = json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&out); err != nil {
		return out, err
	}
	if _, err = uuid.Parse(out.ID); err != nil || len(out.PublicKey) != ed25519.PublicKeySize {
		return out, errors.New("invalid peer identity")
	}
	_, err = PeerCertificate(*resp.TLS, out.PublicKey)
	return out, err
}
