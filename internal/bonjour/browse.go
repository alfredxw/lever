package bonjour

import (
	"github.com/google/uuid"
	"os"
	"runtime"
	"strings"
)

func serviceTXT(id string) []string {
	name, _ := os.Hostname()
	for len(name) > 240 {
		i := strings.LastIndexByte(name, '.')
		if i > 0 {
			name = name[:i]
		} else {
			name = id
			break
		}
	}
	return []string{"id=" + id, "name=" + name, "platform=" + runtime.GOOS, "v=1"}
}

// Instances are untrusted service hints. The advertised service name is the
// stable device ID. Pairing separately verifies the TLS public key.
func validInstance(s string) bool { _, err := uuid.Parse(s); return err == nil && len(s) == 36 }
