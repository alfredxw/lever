package app

import (
	"errors"
	"strings"
	"testing"

	"lever/internal/provider"
)

func TestUnconfirmedHostErrorDoesNotDuplicateSentinel(t *testing.T) {
	base := provider.ErrUnconfirmed.Error()
	for _, tc := range []struct {
		name, detail, want string
	}{
		{"empty", "", base},
		{"bare sentinel", base, base},
		{"joined sentinel", base + "\nAntigravity disconnected", base + "\nAntigravity disconnected"},
		{"prefixed sentinel", base + ": lost worker", base + "\nlost worker"},
		{"plain detail", "worker exited", base + "\nworker exited"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := unconfirmedHostError(tc.detail)
			if !errors.Is(err, provider.ErrUnconfirmed) {
				t.Fatalf("expected ErrUnconfirmed, got %v", err)
			}
			if count := strings.Count(err.Error(), base); count != 1 {
				t.Fatalf("sentinel repeated %d times in %q", count, err.Error())
			}
			if err.Error() != tc.want {
				t.Fatalf("got %q, want %q", err.Error(), tc.want)
			}
		})
	}
}
