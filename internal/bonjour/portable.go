//go:build (!darwin && !ios) || !cgo

package bonjour

import (
	"context"
	"errors"
	"github.com/hashicorp/mdns"
	"io"
	"net"
	"strconv"
	"strings"
	"time"
)

type advertisement struct{ server *mdns.Server }

func (a advertisement) Close() error { return a.server.Shutdown() }
func Advertise(id string, port int, ips []net.IP) (io.Closer, error) {
	zone, err := mdns.NewMDNSService(id, "_lever._tcp", "local.", "lever-"+id+".local.", port, ips, []string{"v=1"})
	if err != nil {
		return nil, err
	}
	server, err := mdns.NewServer(&mdns.Config{Zone: zone})
	if err != nil {
		return nil, err
	}
	return advertisement{server}, nil
}
func Discover(ctx context.Context, id string) (string, error) {
	entries := make(chan *mdns.ServiceEntry, 32)
	params := mdns.DefaultParams("_lever._tcp")
	params.Entries = entries
	params.WantUnicastResponse = true
	params.DisableIPv6 = true
	params.Timeout = 1200 * time.Millisecond
	ctx, cancel := context.WithTimeout(ctx, params.Timeout)
	defer cancel()
	done := make(chan error, 1)
	go func() { err := mdns.QueryContext(ctx, params); close(entries); done <- err }()
	for e := range entries {
		if !strings.EqualFold(e.Name, id+"._lever._tcp.local.") {
			continue
		}
		ip := e.AddrV4
		if ip == nil {
			ip = e.AddrV6
		}
		if ip == nil || (!ip.IsPrivate() && !ip.IsLinkLocalUnicast() && !ip.IsLoopback()) {
			continue
		}
		return net.JoinHostPort(ip.String(), strconv.Itoa(e.Port)), nil
	}
	if err := <-done; err != nil {
		return "", err
	}
	return "", errors.New("Host not on this LAN")
}
