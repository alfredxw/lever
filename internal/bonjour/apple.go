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
struct lever_instances {char names[64][37]; int count;};
static void browsed(DNSServiceRef ref,DNSServiceFlags flags,uint32_t iface,DNSServiceErrorType err,
    const char *name,const char *type,const char *domain,void *context){
    struct lever_instances *out=context;
    if (err || !(flags & kDNSServiceFlagsAdd) || strlen(name)!=36 || out->count>=64) return;
    for(int i=0;i<out->count;i++) if(!strcmp(out->names[i],name)) return;
    strlcpy(out->names[out->count++],name,37);
}
static DNSServiceErrorType lever_browse(int timeout,struct lever_instances *out){
    DNSServiceRef ref;
    DNSServiceErrorType err=DNSServiceBrowse(&ref,0,0,"_lever._tcp","local.",browsed,out);
    if(err) return err;
    struct pollfd fd={DNSServiceRefSockFD(ref),POLLIN,0};
    uint64_t end=clock_gettime_nsec_np(CLOCK_MONOTONIC)+(uint64_t)timeout*1000000;
    while(out->count<64){
        uint64_t now=clock_gettime_nsec_np(CLOCK_MONOTONIC);
        if(now>=end || poll(&fd,1,(int)((end-now)/1000000))<=0) break;
        if((err=DNSServiceProcessResult(ref))) break;
    }
    DNSServiceRefDeallocate(ref);
    return err;
}
static DNSServiceErrorType lever_register(const char *name, int port, const void *txt, uint16_t len, DNSServiceRef *ref) {
    return DNSServiceRegister(ref, 0, 0, name, "_lever._tcp", "local.", NULL, htons(port), len, txt, NULL, NULL);
}
*/
import "C"

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"slices"
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
	var txt []byte
	for _, item := range serviceTXT(id) {
		txt = append(txt, byte(len(item)))
		txt = append(txt, item...)
	}
	if status := C.lever_register(name, C.int(port), unsafe.Pointer(&txt[0]), C.uint16_t(len(txt)), &a.ref); status != 0 {
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

func Browse(ctx context.Context) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, 1200*time.Millisecond)
	defer cancel()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	end, _ := ctx.Deadline()
	var records C.struct_lever_instances
	if err := C.lever_browse(C.int(time.Until(end).Milliseconds()), &records); err != 0 {
		return nil, fmt.Errorf("Bonjour browse failed (%d)", err)
	}
	out := []string{}
	for i := 0; i < int(records.count); i++ {
		if id := C.GoString(&records.names[i][0]); validInstance(id) {
			out = append(out, id)
		}
	}
	slices.Sort(out)
	return out, nil
}
