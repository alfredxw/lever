// Package main builds LeverCore.xcframework for the native iOS app.
// It reuses Lever's Ed25519 request signing, TLS 1.3 leaf pinning, Bonjour
// discovery, LAN-first routing, Hub failover, and sealed APNs payloads while
// delegating secret persistence to the iOS Keychain.
package main

/*
#include <stdlib.h>
#include <stdint.h>

typedef struct {
    int32_t status;
    char* content_type;
    char* error;
    void* data;
    int64_t length;
} lever_binary_result;

typedef char* (*lever_secret_get_fn)(const char* key);
typedef int   (*lever_secret_set_fn)(const char* key, const char* value);
typedef int   (*lever_secret_del_fn)(const char* key);
typedef void  (*lever_event_fn)(const char* kind, const char* payload);
typedef void  (*lever_free_fn)(char* ptr);

static char* lever_call_secret_get(lever_secret_get_fn fn, const char* key) {
    return fn ? fn(key) : NULL;
}
static int lever_call_secret_set(lever_secret_set_fn fn, const char* key, const char* val) {
    return fn ? fn(key, val) : -1;
}
static int lever_call_secret_del(lever_secret_del_fn fn, const char* key) {
    return fn ? fn(key) : -1;
}
static void lever_call_event(lever_event_fn fn, const char* kind, const char* payload) {
    if (fn) fn(kind, payload);
}
static void lever_call_free(lever_free_fn fn, char* ptr) {
    if (fn && ptr) fn(ptr);
}
*/
import "C"

import (
	"bufio"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
	"unsafe"

	"lever/internal/lanclient"
	"lever/internal/model"
	"lever/internal/multinode"
	p "lever/internal/remoteproto"
	"lever/web/hubassets"
)

const (
	accountKey = "paired-controller-v1"
	grantsKey  = "lan-controller-certificates-v1"
	pushKey    = "push-controller-v1"
)

var errSecretNotFound = errors.New("secret not found")

type pushPreference struct {
	DeviceID string `json:"deviceId"`
	Token    string `json:"token"`
	Key      []byte `json:"key"`
}

type core struct {
	mu        sync.Mutex
	accountMu sync.Mutex
	pushMu    sync.Mutex
	directory multinode.MobileDirectory
	workspace multinode.MobileWorkspace
	terminal  multinode.MobileTerminal
	lan       lanclient.Client
	stopWatch context.CancelFunc

	cbMu     sync.RWMutex
	getFn    C.lever_secret_get_fn
	setFn    C.lever_secret_set_fn
	delFn    C.lever_secret_del_fn
	eventFn  C.lever_event_fn
	freeFn   C.lever_free_fn
	memStore map[string]string
}

var instance = newCore()

func newCore() *core {
	c := &core{memStore: map[string]string{}}
	c.lan.LoadGrant = c.loadGrant
	c.lan.SaveGrant = c.saveGrant
	return c
}

func (c *core) secretGet(key string) ([]byte, error) {
	c.cbMu.RLock()
	fn, freeFn := c.getFn, c.freeFn
	c.cbMu.RUnlock()
	if fn == nil {
		c.mu.Lock()
		v, ok := c.memStore[key]
		c.mu.Unlock()
		if !ok {
			return nil, errSecretNotFound
		}
		return []byte(v), nil
	}
	ck := C.CString(key)
	defer C.free(unsafe.Pointer(ck))
	out := C.lever_call_secret_get(fn, ck)
	if out == nil {
		return nil, errSecretNotFound
	}
	val := C.GoString(out)
	if freeFn != nil {
		C.lever_call_free(freeFn, out)
	} else {
		C.free(unsafe.Pointer(out))
	}
	return []byte(val), nil
}

func (c *core) secretSet(key string, val []byte) error {
	c.cbMu.RLock()
	fn := c.setFn
	c.cbMu.RUnlock()
	if fn == nil {
		c.mu.Lock()
		c.memStore[key] = string(val)
		c.mu.Unlock()
		return nil
	}
	ck := C.CString(key)
	cv := C.CString(string(val))
	defer C.free(unsafe.Pointer(ck))
	defer C.free(unsafe.Pointer(cv))
	if C.lever_call_secret_set(fn, ck, cv) != 0 {
		return errors.New("无法保存凭证到系统钥匙串")
	}
	return nil
}

func (c *core) secretDelete(key string) error {
	c.cbMu.RLock()
	fn := c.delFn
	c.cbMu.RUnlock()
	if fn == nil {
		c.mu.Lock()
		delete(c.memStore, key)
		c.mu.Unlock()
		return nil
	}
	ck := C.CString(key)
	defer C.free(unsafe.Pointer(ck))
	if C.lever_call_secret_del(fn, ck) != 0 {
		return errors.New("无法从系统钥匙串移除凭证")
	}
	return nil
}

func (c *core) emit(kind, payload string) {
	c.cbMu.RLock()
	fn := c.eventFn
	c.cbMu.RUnlock()
	if fn == nil {
		return
	}
	ck := C.CString(kind)
	cp := C.CString(payload)
	defer C.free(unsafe.Pointer(ck))
	defer C.free(unsafe.Pointer(cp))
	C.lever_call_event(fn, ck, cp)
}

func (c *core) accounts() (multinode.Accounts, error) {
	var a multinode.Accounts
	raw, err := c.secretGet(accountKey)
	if err != nil {
		return a, err
	}
	if err = json.Unmarshal(raw, &a); err != nil {
		return a, err
	}
	if len(a.Key) != ed25519.PrivateKeySize || a.Membership.Role != p.Controller {
		return a, errors.New("invalid controller credential")
	}
	return a, nil
}
func (c *core) paired() (p.ClientState, error) { a, err := c.accounts(); return a.ClientState, err }

func (c *core) savedGrants() map[string]string {
	out := map[string]string{}
	raw, err := c.secretGet(grantsKey)
	if err == nil {
		_ = json.Unmarshal(raw, &out)
	}
	return out
}

func (c *core) loadGrant(key string) string {
	c.accountMu.Lock()
	defer c.accountMu.Unlock()
	return c.savedGrants()[key]
}

func (c *core) saveGrant(key, token string) {
	c.accountMu.Lock()
	defer c.accountMu.Unlock()
	st, err := c.paired()
	if err != nil || !strings.HasPrefix(key, st.Membership.Hub.ID+"/"+st.Membership.SpaceID+"/"+st.Membership.DeviceID+"/") {
		return
	}
	grants := c.savedGrants()
	grants[key] = token
	raw, _ := json.Marshal(grants)
	_ = c.secretSet(grantsKey, raw)
}

func parseHubPairLink(link string) (string, string, error) {
	u, err := url.Parse(strings.TrimSpace(link))
	if err != nil || u.Scheme != "leverdevice" || u.Host != "pair" || u.User != nil {
		return "", "", errors.New("请在电脑「设置 → 远程与设备」点击配对新设备获取二维码或链接")
	}
	base, err := p.Origin(u.Query().Get("hub"))
	if err != nil {
		return "", "", err
	}
	code := u.Query().Get("code")
	if code == "" {
		return "", "", errors.New("配对链接缺少配对码")
	}
	return base, code, nil
}

func isValidPairLink(link string) bool {
	if _, isDirect, err := p.ParseDirectPairLink(link); isDirect {
		return err == nil
	}
	_, _, err := parseHubPairLink(link)
	return err == nil
}

func (c *core) forget(st p.ClientState) error {
	a, err := c.accounts()
	if err != nil {
		return err
	}
	removed, remaining := a.Remove(st)
	if !removed {
		return nil
	}
	c.lan.Forget(st)
	c.workspace.Close()
	c.terminal.Close()
	c.directory.Clear()
	c.mu.Lock()
	if c.stopWatch != nil {
		c.stopWatch()
		c.stopWatch = nil
	}
	c.mu.Unlock()
	if remaining {
		raw, err := json.Marshal(a)
		if err != nil {
			return err
		}
		if err = c.secretSet(accountKey, raw); err != nil {
			return err
		}
		if !st.IsDirect() {
			_ = c.secretDelete(pushKey)
			_ = c.secretDelete(grantsKey)
		}
		return nil
	}
	_ = c.secretDelete(grantsKey)
	_ = c.secretDelete(pushKey)
	return c.secretDelete(accountKey)
}

func (c *core) pair(link, deviceName string) error {
	c.accountMu.Lock()
	defer c.accountMu.Unlock()
	a, err := c.accounts()
	if err != nil && !errors.Is(err, errSecretNotFound) {
		return err
	}
	name := strings.TrimSpace(deviceName)
	if name == "" {
		name = "Lever"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err = a.Pair(ctx, link, name, "ios"); err != nil {
		return err
	}
	raw, err := json.Marshal(a)
	if err != nil {
		return err
	}
	if err = c.secretSet(accountKey, raw); err != nil {
		return err
	}
	c.mu.Lock()
	if c.stopWatch != nil {
		c.stopWatch()
		c.stopWatch = nil
	}
	c.mu.Unlock()
	return nil
}

func (c *core) unpair(id string) error {
	c.accountMu.Lock()
	a, err := c.accounts()
	c.accountMu.Unlock()
	if err != nil {
		if errors.Is(err, errSecretNotFound) {
			return nil
		}
		return err
	}
	st, err := a.SelectForRemoval(id)
	if err != nil {
		return err
	}
	if err = multinode.Revoke(context.Background(), &c.lan, st); err != nil {
		return err
	}
	c.accountMu.Lock()
	defer c.accountMu.Unlock()
	return c.forget(st)
}

func (c *core) requestDirect(ctx context.Context, st p.ClientState, method, path, body string) (json.RawMessage, error) {
	if out, ok, err := c.lan.Local(ctx, st, method, path, []byte(body)); ok {
		return out, err
	}
	mb := st.Membership
	spacePath := st.SpacePath()
	if method == "GET" && path == "/api/me" {
		name := st.HostName
		if name == "" {
			name = "局域网直连"
		}
		raw, _ := json.Marshal(map[string]any{
			"hub":      mb.Hub,
			"userId":   mb.UserID,
			"spaces":   []p.Space{{ID: mb.SpaceID, Kind: "personal", Name: name}},
			"deviceId": mb.DeviceID,
			"origin":   "",
		})
		return raw, nil
	}
	if method == "GET" && path == spacePath+"/devices" {
		hostName := st.HostName
		if hostName == "" {
			hostName = "我的电脑"
		}
		hostPlatform := st.HostPlatform
		if hostPlatform == "" {
			hostPlatform = "darwin"
		}
		hostDev := p.Device{
			Identity: mb.Hub,
			SpaceID:  mb.SpaceID,
			Name:     hostName,
			Role:     p.Workstation,
			Platform: hostPlatform,
			Online:   false,
		}
		pingCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
		defer cancel()
		if live, err := c.lan.HostInfo(pingCtx, st, mb.Hub.ID); err == nil {
			hostDev = live
		}
		selfDev := p.Device{
			Identity: p.Identity{ID: mb.DeviceID},
			SpaceID:  mb.SpaceID,
			Name:     "iPhone",
			Role:     p.Controller,
			Platform: "ios",
			Online:   true,
		}
		raw, _ := json.Marshal([]p.Device{hostDev, selfDev})
		return raw, nil
	}
	if method == "GET" && path == spacePath+"/tasks" {
		return json.RawMessage("[]"), nil
	}
	if method == "GET" && path == spacePath+"/read" {
		return json.RawMessage("{}"), nil
	}
	if method == "GET" && path == spacePath+"/cleared" {
		return json.RawMessage("{}"), nil
	}
	if method == "GET" && path == spacePath+"/push" {
		return json.RawMessage(`{"available":false,"enabled":false,"silenceWhenDesktopActive":true}`), nil
	}
	if strings.HasPrefix(path, spacePath+"/archive/") {
		return nil, errors.New("当前不在同一局域网，暂时无法连接电脑")
	}
	return nil, errors.New("该功能需要连接 Lever Hub（当前为局域网直连模式）")
}

func (c *core) request(method, path, body string) (json.RawMessage, error) {
	accounts, err := c.accounts()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if method == "DELETE" && strings.HasPrefix(path, "/native/direct-peers/") {
		id := strings.TrimPrefix(path, "/native/direct-peers/")
		if id == "" {
			return nil, errors.New("missing node id")
		}
		return json.RawMessage("true"), c.unpair(id)
	}
	if method == "POST" && (path == "/native/workspace/close" || path == "/native/terminal/close") {
		if path == "/native/workspace/close" && (body == "" || body == "{}" || body == "null") {
			c.workspace.Close()
			return json.RawMessage("true"), nil
		}
		var args struct{ Host string }
		if err := json.Unmarshal([]byte(body), &args); err != nil {
			return nil, err
		}
		if path == "/native/terminal/close" {
			c.terminal.CloseHost(args.Host)
		} else {
			c.workspace.CloseHost(args.Host)
		}
		return json.RawMessage("true"), nil
	}
	if path == "/native/terminal" && method == "POST" {
		var args multinode.TerminalRequest
		if err := json.Unmarshal([]byte(body), &args); err != nil {
			return nil, err
		}
		location, err := c.terminal.Open(&c.directory, args)
		if err != nil {
			return nil, err
		}
		return json.Marshal(location)
	}
	if path == "/native/workspace" && method == "POST" {
		var args struct{ Node, Agent, Chat string }
		if err := json.Unmarshal([]byte(body), &args); err != nil {
			return nil, err
		}
		location, err := c.workspace.Open(&c.directory, hubassets.Assets(), args.Node, args.Agent, args.Chat)
		if err != nil {
			return nil, err
		}
		return json.Marshal(location)
	}
	if raw, ok, e := c.directory.Request(ctx, accounts.SpacePath(), method, path, body); ok {
		return raw, e
	}
	st, path, _ := accounts.Resolve(method, path, body)
	if method == "GET" && path == accounts.SpacePath()+"/devices" && accounts.IsDirect() {
		base := []p.Device{{Identity: p.Identity{ID: accounts.Membership.DeviceID}, Name: "Lever", Role: p.Controller, Online: true}}
		raw, err := json.Marshal(c.directory.Refresh(ctx, accounts, &c.lan, base))
		return raw, err
	}
	if st.IsDirect() {
		return c.requestDirect(ctx, st, method, path, body)
	}
	if method == "GET" && path == "/api/me" {
		var quick context.CancelFunc
		ctx, quick = context.WithTimeout(ctx, 2*time.Second)
		defer quick()
	}
	if out, ok, err := c.lan.Local(ctx, st, method, path, []byte(body)); ok {
		return out, err
	}
	target := path
	directory := method == "GET" && path == st.SpacePath()+"/devices"
	if directory {
		target += "?lan=1"
	}
	req, err := st.Request(ctx, method, target, []byte(body))
	if err != nil {
		return nil, err
	}
	var out json.RawMessage
	err = p.Exchange(p.Client, req, &out)
	if err != nil {
		var response *p.HTTPError
		if errors.As(err, &response) {
			if response.Status == 401 {
				c.accountMu.Lock()
				current, readErr := c.paired()
				if readErr == nil && current.Membership.Token == st.Membership.Token {
					_ = c.forget(st)
					c.emit("unpaired", "")
				}
				c.accountMu.Unlock()
			}
			return nil, err
		}
		if directory && len(accounts.Peers) > 0 {
			raw, err := json.Marshal(c.directory.Refresh(ctx, accounts, &c.lan, nil))
			return raw, err
		}
		if method == "GET" && path == "/api/me" {
			mb := st.Membership
			raw, _ := json.Marshal(map[string]any{
				"hub":      mb.Hub,
				"userId":   mb.UserID,
				"spaces":   []p.Space{{ID: mb.SpaceID, Kind: "personal", Name: "Hub"}},
				"deviceId": mb.DeviceID,
				"origin":   st.Origin,
			})
			return raw, nil
		}
		var network *url.Error
		if errors.As(err, &network) {
			return nil, errors.New("暂时无法连接 Hub")
		}
		return nil, err
	}
	if path == "/api/me" {
		var v map[string]any
		if json.Unmarshal(out, &v) == nil {
			v["origin"] = st.Origin
			out, _ = json.Marshal(v)
		}
	}
	if directory {
		var entries []struct {
			p.Device
			LANProof string `json:"lanProof"`
		}
		if err := json.Unmarshal(out, &entries); err != nil {
			return nil, err
		}
		devices := make([]p.Device, 0, len(entries))
		for _, d := range entries {
			if d.LANProof != "" {
				c.lan.RememberHost(st, d.ID, d.LANProof)
			}
			devices = append(devices, d.Device)
		}
		out, _ = json.Marshal(c.directory.Refresh(ctx, accounts, &c.lan, devices))
	}
	return out, nil
}

func (c *core) watch(active bool) error {
	var slots multinode.Accounts
	if active {
		var err error
		slots, err = c.accounts()
		if err != nil {
			return err
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if !active {
		c.terminal.Close()
		if c.stopWatch != nil {
			c.stopWatch()
			c.stopWatch = nil
		}
		return nil
	}
	if c.stopWatch != nil {
		return nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	c.stopWatch = cancel
	go slots.WatchNodes(ctx, &c.lan, func() { c.emit("refresh", "") })
	if !slots.IsDirect() {
		go c.watchEvents(ctx, slots.ClientState)
	}
	return nil
}

func (c *core) watchEvents(ctx context.Context, st p.ClientState) {
	client := http.Client{CheckRedirect: p.Client.CheckRedirect}
	for ctx.Err() == nil {
		req, err := st.Request(ctx, "GET", st.SpacePath()+"/events", nil)
		if err != nil {
			return
		}
		resp, err := client.Do(req)
		if err == nil {
			if resp.StatusCode == http.StatusUnauthorized {
				resp.Body.Close()
				_, _ = c.request("GET", "/api/me", "")
				return
			}
			if resp.StatusCode == http.StatusOK {
				scanner := bufio.NewScanner(resp.Body)
				for scanner.Scan() {
					if scanner.Text() == "data: refresh" {
						c.emit("refresh", "")
					}
				}
			}
			resp.Body.Close()
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(3 * time.Second):
		}
	}
}

func (c *core) pushPreference() pushPreference {
	var pref pushPreference
	raw, err := c.secretGet(pushKey)
	if err == nil {
		_ = json.Unmarshal(raw, &pref)
	}
	return pref
}

func (c *core) registerPushToken(token string) error {
	c.pushMu.Lock()
	defer c.pushMu.Unlock()
	st, err := c.paired()
	if err != nil {
		return err
	}
	if st.IsDirect() {
		return errors.New("锁屏通知需要连接 Lever Hub")
	}
	token = strings.TrimSpace(token)
	if token == "" {
		return errors.New("missing push token")
	}
	pref := c.pushPreference()
	if pref.DeviceID != st.Membership.DeviceID || len(pref.Key) != 32 {
		pref = pushPreference{DeviceID: st.Membership.DeviceID, Key: make([]byte, 32)}
		_, _ = rand.Read(pref.Key)
	}
	pref.Token = token
	b, _ := json.Marshal(pref)
	if err := c.secretSet(pushKey, b); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	return st.Do(ctx, "PUT", st.SpacePath()+"/push", p.PushRegistration{Token: token, Key: pref.Key}, nil)
}

func (c *core) disablePush() error {
	c.pushMu.Lock()
	defer c.pushMu.Unlock()
	st, err := c.paired()
	if err != nil {
		return err
	}
	if !st.IsDirect() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := st.Do(ctx, "DELETE", st.SpacePath()+"/push", nil, nil); err != nil {
			return err
		}
	}
	return c.secretDelete(pushKey)
}

func (c *core) openPush(payload string) (*p.PushNotice, error) {
	st, err := c.paired()
	if err != nil {
		return nil, err
	}
	pref := c.pushPreference()
	n, err := p.OpenPush(payload, pref.Key)
	if err != nil || pref.DeviceID != st.Membership.DeviceID || n.HubID != st.Membership.Hub.ID || n.SpaceID != st.Membership.SpaceID {
		return nil, errors.New("无法解析推送通知")
	}
	return &n, nil
}

func okJSON(data any) *C.char {
	b, err := json.Marshal(map[string]any{"ok": true, "data": data})
	if err != nil {
		return errJSON(err)
	}
	return C.CString(string(b))
}

func okRawJSON(raw json.RawMessage) *C.char {
	if len(raw) == 0 {
		raw = json.RawMessage("null")
	}
	b, err := json.Marshal(map[string]any{"ok": true, "data": raw})
	if err != nil {
		return errJSON(err)
	}
	return C.CString(string(b))
}

func errJSON(err error) *C.char {
	msg := "unknown error"
	if err != nil {
		msg = err.Error()
	}
	payload := map[string]any{"ok": false, "error": msg}
	var httpErr *p.HTTPError
	if errors.As(err, &httpErr) {
		payload["status"] = httpErr.Status
	}
	b, _ := json.Marshal(payload)
	return C.CString(string(b))
}

//export LeverCore_Init
func LeverCore_Init(
	getFn C.lever_secret_get_fn,
	setFn C.lever_secret_set_fn,
	delFn C.lever_secret_del_fn,
	eventFn C.lever_event_fn,
	freeFn C.lever_free_fn,
) {
	instance.cbMu.Lock()
	instance.getFn = getFn
	instance.setFn = setFn
	instance.delFn = delFn
	instance.eventFn = eventFn
	instance.freeFn = freeFn
	instance.cbMu.Unlock()
}

//export LeverCore_FetchBinary
func LeverCore_FetchBinary(path *C.char) *C.lever_binary_result {
	res := (*C.lever_binary_result)(C.calloc(1, C.size_t(C.sizeof_lever_binary_result)))
	if res == nil {
		return nil
	}
	b, mime, err := instance.media(C.GoString(path))
	if err != nil {
		res.error = C.CString(err.Error())
		var he *p.HTTPError
		if errors.As(err, &he) {
			res.status = C.int32_t(he.Status)
		}
		return res
	}
	res.status = 200
	res.content_type = C.CString(mime)
	res.length = C.int64_t(len(b))
	res.data = C.CBytes(b)
	return res
}

//export LeverCore_FreeBinary
func LeverCore_FreeBinary(res *C.lever_binary_result) {
	if res == nil {
		return
	}
	C.free(res.data)
	C.free(unsafe.Pointer(res.error))
	C.free(unsafe.Pointer(res.content_type))
	C.free(unsafe.Pointer(res))
}

func (c *core) media(path string) ([]byte, string, error) {
	accounts, err := c.accounts()
	if err != nil {
		return nil, "", err
	}
	suffix, ok := strings.CutPrefix(path, accounts.SpacePath()+"/")
	parts := strings.Split(suffix, "/")
	if !ok || strings.ContainsAny(suffix, "%?#\\\\") || strings.Contains(suffix, "..") {
		return nil, "", errors.New("无效的媒体路径")
	}
	if len(parts) == 4 && parts[0] == "nodes" && parts[2] == "attachments" && parts[3] != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		return c.directory.Attachment(ctx, parts[1], parts[3])
	}
	if len(parts) == 3 && parts[0] == "avatars" && parts[1] != "" && parts[2] != "" {
		raw, err := c.request("GET", path, "")
		if err != nil {
			return nil, "", err
		}
		var image struct {
			Data      []byte
			MediaType string
		}
		if err := json.Unmarshal(raw, &image); err != nil {
			return nil, "", err
		}
		if len(image.Data) > model.MaxAttachmentBytes {
			return nil, "", errors.New("头像超过大小限制")
		}
		return image.Data, image.MediaType, nil
	}
	return nil, "", errors.New("无效的媒体路径")
}

//export LeverCore_Free
func LeverCore_Free(ptr *C.char) {
	if ptr != nil {
		C.free(unsafe.Pointer(ptr))
	}
}

//export LeverCore_Status
func LeverCore_Status() *C.char {
	st, err := instance.accounts()
	if err != nil {
		return okJSON(map[string]any{"paired": false})
	}
	pref := instance.pushPreference()
	return okJSON(map[string]any{
		"paired":        true,
		"directPeerIds": st.DirectIDs(),
		"direct":        st.IsDirect(),
		"hostName":      st.HostName,
		"hostPlatform":  st.HostPlatform,
		"origin":        st.Origin,
		"hubId":         st.Membership.Hub.ID,
		"spaceId":       st.Membership.SpaceID,
		"deviceId":      st.Membership.DeviceID,
		"userId":        st.Membership.UserID,
		"pushEnabled":   pref.DeviceID == st.Membership.DeviceID && pref.Token != "",
	})
}

//export LeverCore_ValidPairLink
func LeverCore_ValidPairLink(link *C.char) C.int {
	if isValidPairLink(C.GoString(link)) {
		return 1
	}
	return 0
}

//export LeverCore_Pair
func LeverCore_Pair(link *C.char, deviceName *C.char) *C.char {
	if err := instance.pair(C.GoString(link), C.GoString(deviceName)); err != nil {
		return errJSON(err)
	}
	return okJSON(true)
}

//export LeverCore_Unpair
func LeverCore_Unpair() *C.char {
	if err := instance.unpair(""); err != nil {
		return errJSON(err)
	}
	return okJSON(true)
}

//export LeverCore_Request
func LeverCore_Request(method *C.char, path *C.char, body *C.char) *C.char {
	raw, err := instance.request(C.GoString(method), C.GoString(path), C.GoString(body))
	if err != nil {
		return errJSON(err)
	}
	return okRawJSON(raw)
}

//export LeverCore_Watch
func LeverCore_Watch(active C.int) *C.char {
	if err := instance.watch(active != 0); err != nil {
		return errJSON(err)
	}
	return okJSON(true)
}

//export LeverCore_NetworkChanged
func LeverCore_NetworkChanged() {
	instance.lan.NetworkChanged()
	instance.emit("refresh", "")
}

//export LeverCore_RegisterPushToken
func LeverCore_RegisterPushToken(token *C.char) *C.char {
	if err := instance.registerPushToken(C.GoString(token)); err != nil {
		return errJSON(err)
	}
	return okJSON(true)
}

//export LeverCore_DisablePush
func LeverCore_DisablePush() *C.char {
	if err := instance.disablePush(); err != nil {
		return errJSON(err)
	}
	return okJSON(true)
}

//export LeverCore_OpenPush
func LeverCore_OpenPush(payload *C.char) *C.char {
	notice, err := instance.openPush(C.GoString(payload))
	if err != nil {
		return errJSON(err)
	}
	return okJSON(notice)
}

func main() {}
