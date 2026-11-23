package remoteproto

import (
	"crypto/ed25519"
	"crypto/rand"
	"net/http/httptest"
	"testing"
	"time"
)

func TestDeviceProofAndLANAuthority(t *testing.T) {
	pub, key, _ := ed25519.GenerateKey(rand.Reader)
	r := httptest.NewRequest("POST", "https://hub.example/api/spaces/one/tasks", nil)
	now := time.Now()
	body := []byte("one")
	Sign(r, "token", key, body)
	if !Verify(r, pub, body, now) {
		t.Fatal("valid proof rejected")
	}
	if Verify(r, pub, []byte("changed"), now) || Verify(r, pub, body, now.Add(2*time.Minute)) {
		t.Fatal("stale or changed request accepted")
	}
	r.URL.Path = "/api/spaces/two/tasks"
	if Verify(r, pub, body, now) {
		t.Fatal("substituted target accepted")
	}
	workspace := Identity{ID: "hub", PublicKey: pub}
	g := Grant{HubID: "hub", SpaceID: "one", Controller: Identity{ID: "B", PublicKey: pub}, Host: Identity{ID: "A", PublicKey: pub}, Policy: 4, Expires: now.Add(3 * time.Minute).Unix()}
	sign, err := ParseGrant(IssueGrant(g, key))
	if err != nil {
		t.Fatal(err)
	}
	if !sign.Valid(workspace, "A", "one", 4, now) || sign.Valid(workspace, "A", "two", 4, now) || sign.Valid(workspace, "A", "one", 5, now) || sign.Valid(workspace, "A", "one", 4, now.Add(5*time.Minute)) {
		t.Fatal("LAN scope, revocation or expiry check failed")
	}
	sign.Grant.Host.ID = "C"
	if sign.Valid(workspace, "C", "one", 4, now) {
		t.Fatal("tampered grant accepted")
	}
}
