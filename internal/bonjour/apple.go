//go:build (darwin || ios) && cgo

// Package bonjour advertises and resolves the Lever service on the local link.
// Apple platforms use the system daemon so discovery observes Local Network
// permission and does not compete with mDNSResponder for multicast packets.
package bonjour

/*
#include <dns_sd.h>
#include <arpa/inet.h>
#include <poll.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

struct lever_service {
    char host[kDNSServiceMaxDomainName];
    int port;
    DNSServiceErrorType error;
    int done;
};
static void resolved(DNSServiceRef ref, DNSServiceFlags flags, uint32_t iface,
        DNSServiceErrorType error, const char *name, const char *host, uint16_t port,
        uint16_t txtLen, const unsigned char *txt, void *context) {
    struct lever_service *reply = context;
    reply->error = error;
    if (!error && host) {
        strlcpy(reply->host, host, sizeof(reply->host));
        reply->port = ntohs(port);
    }
    reply->done = 1;
}
static DNSServiceErrorType lever_resolve(const char *name, int milliseconds, struct lever_service *reply) {
    DNSServiceRef ref;
    DNSServiceErrorType error = DNSServiceResolve(&ref, 0, 0, name, "_lever._tcp", "local.", resolved, reply);
    if (error) return error;
    struct pollfd fd = {DNSServiceRefSockFD(ref), POLLIN, 0};
    uint64_t end = clock_gettime_nsec_np(CLOCK_MONOTONIC) + (uint64_t)milliseconds * 1000000;
    while (!reply->done) {
        uint64_t now = clock_gettime_nsec_np(CLOCK_MONOTONIC);
        if (now >= end || poll(&fd, 1, (int)((end - now) / 1000000)) <= 0) {
            error = kDNSServiceErr_Timeout;
            break;
        }
        error = DNSServiceProcessResult(ref);
        if (error) break;
    }
    DNSServiceRefDeallocate(ref);
    return error ? error : reply->error;
}
static DNSServiceErrorType lever_register(const char *name, int port, DNSServiceRef *ref) {
    return DNSServiceRegister(ref, 0, 0, name, "_lever._tcp", "local.", NULL, htons(port), 0, NULL, NULL, NULL);
}
*/
import "C"

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"time"
	"unsafe"
)

type advertisement struct{ ref C.DNSServiceRef }

func (a advertisement) Close() error { C.DNSServiceRefDeallocate(a.ref); return nil }

func Advertise(id string, port int, _ []net.IP) (io.Closer, error) {
	name := C.CString(id)
	defer C.free(unsafe.Pointer(name))
	var a advertisement
	if status := C.lever_register(name, C.int(port), &a.ref); status != 0 {
		return nil, fmt.Errorf("Bonjour registration failed (%d)", status)
	}
	return a, nil
}

func Discover(ctx context.Context, id string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 1500*time.Millisecond)
	defer cancel()
	if err := ctx.Err(); err != nil {
		return "", err
	}
	deadline, _ := ctx.Deadline()
	name := C.CString(id)
	defer C.free(unsafe.Pointer(name))
	var reply C.struct_lever_service
	if status := C.lever_resolve(name, C.int(time.Until(deadline).Milliseconds()), &reply); status != 0 {
		return "", fmt.Errorf("Bonjour could not resolve Host (%d)", status)
	}
	ips, err := net.DefaultResolver.LookupIP(ctx, "ip4", C.GoString(&reply.host[0]))
	if err != nil {
		return "", err
	}
	for _, ip := range ips {
		if ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
			return net.JoinHostPort(ip.String(), strconv.Itoa(int(reply.port))), nil
		}
	}
	return "", errors.New("Host has no local IPv4 address")
}
