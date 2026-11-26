package hub

import (
	"bytes"
	"crypto/rand"
	"database/sql"
	"encoding/base32"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	p "lever/internal/remoteproto"
)

type problem struct {
	code    int
	message string
}

func (e problem) Error() string     { return e.message }
func invalid(message string) error  { return problem{400, message} }
func conflict(message string) error { return problem{409, message} }

var denied = problem{403, "access denied"}
var unauth = problem{401, "sign in or pair this device"}

type principal struct {
	user, device, space, session, token string
	role                                p.Role
}
type endpoint func(http.ResponseWriter, *http.Request, principal) error

func fail(w http.ResponseWriter, err error) {
	var pr problem
	switch {
	case errors.As(err, &pr):
		http.Error(w, pr.message, pr.code)
	case errors.Is(err, sql.ErrNoRows):
		http.Error(w, "not found", 404)
	default:
		slog.Error("Hub request", "error", err)
		http.Error(w, "Hub could not complete the request", 500)
	}
}
func send(w http.ResponseWriter, v any) error {
	w.Header().Set("Content-Type", "application/json")
	return json.NewEncoder(w).Encode(v)
}
func read(r *http.Request, v any) error {
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		return problem{415, "expected application/json"}
	}
	b, err := io.ReadAll(r.Body)
	if err != nil {
		return invalid("body too large")
	}
	if err = p.Decode(b, v); err != nil {
		return invalid("invalid JSON: " + err.Error())
	}
	return nil
}
func (h *Hub) handler(level string, next endpoint) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var who principal
		var err error
		if level != "public" {
			who, err = h.authenticate(r)
		}
		space := r.PathValue("space")
		if err == nil && space != "" && level != "public" {
			if who.device != "" && space != who.space {
				err = denied
			} else {
				var member bool
				err = h.db.QueryRowContext(r.Context(), "SELECT EXISTS(SELECT 1 FROM memberships WHERE space_id=? AND user_id=?)", space, who.user).Scan(&member)
				if err == nil && !member {
					err = denied
				}
			}
		}
		if err == nil && level == "controller" && !who.role.Controls() {
			err = denied
		}
		if err == nil && level == "executor" && (who.device == "" || !who.role.Executes()) {
			err = denied
		}
		if err == nil && level == "browser" && who.session == "" {
			err = denied
		}
		if err == nil {
			err = next(w, r, who)
		}
		if err != nil {
			fail(w, err)
		}
	}
}
func (h *Hub) Handler(assets fs.FS) http.Handler {
	m := http.NewServeMux()
	m.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok\n")) })
	m.HandleFunc("POST /api/login", h.handler("public", h.login))
	m.HandleFunc("POST /api/pair", h.handler("public", h.pair))
	m.HandleFunc("POST /api/push-relay", h.handler("public", h.relayPush))
	m.HandleFunc("GET /api/me", h.handler("any", h.me))
	m.HandleFunc("POST /api/logout", h.handler("browser", h.logout))
	m.HandleFunc("GET /api/sessions", h.handler("browser", h.sessions))
	m.HandleFunc("DELETE /api/sessions/{id}", h.handler("browser", h.revokeSession))
	m.HandleFunc("POST /api/spaces/{space}/tickets", h.handler("controller", h.ticket))
	m.HandleFunc("GET /api/spaces/{space}/devices", h.handler("controller", h.devices))
	m.HandleFunc("PATCH /api/spaces/{space}/devices/{id}", h.handler("controller", h.editDevice))
	m.HandleFunc("DELETE /api/spaces/{space}/devices/{id}", h.handler("any", h.revoke))
	m.HandleFunc("GET /api/spaces/{space}/events", h.handler("controller", h.events))
	m.HandleFunc("GET /api/spaces/{space}/push", h.handler("controller", h.pushDevice))
	m.HandleFunc("PUT /api/spaces/{space}/push", h.handler("controller", h.pushDevice))
	m.HandleFunc("DELETE /api/spaces/{space}/push", h.handler("controller", h.pushDevice))
	m.HandleFunc("GET /api/spaces/{space}/archive/{device}", h.handler("controller", h.archive))
	m.HandleFunc("GET /api/spaces/{space}/read", h.handler("controller", h.readCursors))
	m.HandleFunc("POST /api/spaces/{space}/read", h.handler("controller", h.markRead))
	m.HandleFunc("GET /api/spaces/{space}/connect", h.handler("any", h.connect))
	m.HandleFunc("GET /api/spaces/{space}/devices/{id}/lan", h.handler("controller", h.grant))
	m.HandleFunc("GET /api/spaces/{space}/controllers/{id}", h.handler("executor", h.personalController))
	h.taskRoutes(m)
	m.HandleFunc("GET /api/", http.NotFound)
	if assets != nil {
		files := http.FileServerFS(assets)
		m.Handle("GET /assets/", files)
		m.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/" && r.URL.Path != "/pair" && !strings.HasPrefix(r.URL.Path, "/s/") {
				http.NotFound(w, r)
				return
			}
			html, err := fs.ReadFile(assets, "hub.html")
			if err != nil {
				http.Error(w, "Hub Web build missing", 503)
				return
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Write(html)
		})
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'")
		w.Header().Set("Cache-Control", "no-store")
		if origin := r.Header.Get("Origin"); origin != "" {
			u, err := url.Parse(origin)
			if err != nil || u.Host != r.Host || (u.Scheme != "https" && !(u.Scheme == "http" && p.Loopback(u.Hostname()))) {
				fail(w, denied)
				return
			}
		}
		if r.Header.Get("Sec-Fetch-Site") == "cross-site" && strings.HasPrefix(r.URL.Path, "/api/") {
			fail(w, denied)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, p.MaxFrame)
		m.ServeHTTP(w, r)
	})
}
func (h *Hub) authenticate(r *http.Request) (principal, error) {
	var a principal
	if hdr := r.Header.Get("Authorization"); hdr != "" {
		token, ok := strings.CutPrefix(hdr, "Bearer ")
		if !ok || len(token) != 43 {
			return a, unauth
		}
		a.token = p.Digest([]byte(token))
		var pub []byte
		err := h.db.QueryRowContext(r.Context(), "SELECT space_id,id,user_id,role,pub FROM devices WHERE token=? AND revoked=0", a.token).Scan(&a.space, &a.device, &a.user, &a.role, &pub)
		if errors.Is(err, sql.ErrNoRows) {
			return a, unauth
		}
		if err != nil {
			return a, err
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			return a, invalid("body too large")
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		now := time.Now()
		if !p.Verify(r, pub, body, now) {
			return a, unauth
		}
		_, err = h.db.Exec("DELETE FROM nonces WHERE expires<?", now.Unix())
		if err != nil {
			return a, err
		}
		res, err := h.db.Exec("INSERT OR IGNORE INTO nonces VALUES(?,?,?)", a.token, r.Header.Get("X-Lever-Nonce"), now.Unix()+121)
		if err != nil {
			return a, err
		}
		n, _ := res.RowsAffected()
		if n != 1 {
			return a, unauth
		}
		if a.role == p.Controller {
			if _, err = h.db.Exec("UPDATE devices SET seen=? WHERE token=? AND seen<?", now.Unix(), a.token, now.Add(-15*time.Second).Unix()); err != nil {
				return a, err
			}
		}
		return a, nil
	}
	c, err := r.Cookie("lever_hub")
	if err != nil {
		return a, unauth
	}
	err = h.db.QueryRowContext(r.Context(), "SELECT id,user_id FROM sessions WHERE token=? AND expires>?", p.Digest([]byte(c.Value)), time.Now().Unix()).Scan(&a.session, &a.user)
	if errors.Is(err, sql.ErrNoRows) {
		return a, unauth
	}
	a.role = p.Controller
	return a, err
}
func (h *Hub) attempt(keys ...string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	now := time.Now()
	if len(h.limits) > 4096 {
		for k, a := range h.limits {
			if now.After(a.until) {
				delete(h.limits, k)
			}
		}
	}
	for _, k := range keys {
		a := h.limits[k]
		if now.Before(a.until) && a.count >= 12 {
			return false
		}
	}
	if len(h.limits) > 8192 {
		return false
	}
	for _, k := range keys {
		a := h.limits[k]
		if !now.Before(a.until) {
			a = attempts{until: now.Add(3 * time.Minute)}
		}
		a.count++
		h.limits[k] = a
	}
	return true
}
func clientIP(r *http.Request) string { host, _, _ := net.SplitHostPort(r.RemoteAddr); return host }
func (h *Hub) login(w http.ResponseWriter, r *http.Request, _ principal) error {
	var in struct {
		Name     string `json:"name"`
		Password string `json:"password"`
	}
	if err := read(r, &in); err != nil {
		return err
	}
	if len(in.Password) > 1024 || len(in.Name) > 120 {
		return unauth
	}
	if !h.attempt("ip:"+clientIP(r), "user:"+in.Name) {
		return problem{429, "too many attempts; try again later"}
	}
	select {
	case h.hashSlots <- struct{}{}:
		defer func() { <-h.hashSlots }()
	default:
		return problem{429, "login busy"}
	}
	var uid string
	var salt, verifier []byte
	err := h.db.QueryRow("SELECT id,salt,verifier FROM users WHERE name=?", in.Name).Scan(&uid, &salt, &verifier)
	if errors.Is(err, sql.ErrNoRows) {
		salt = make([]byte, 16)
		verifier = make([]byte, 32)
	} else if err != nil {
		return err
	}
	if !matches(in.Password, salt, verifier) || uid == "" {
		return problem{401, "invalid name or password"}
	}
	token := p.Token()
	expires := time.Now().Add(14 * 24 * time.Hour)
	// A simultaneous password reset invalidates the verifier read before hashing.
	res, err := h.db.Exec("INSERT INTO sessions SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM users WHERE id=? AND verifier=?)", p.NewID(), p.Digest([]byte(token)), uid, expires.Unix(), r.UserAgent(), uid, verifier)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return unauth
	}
	u := url.URL{Host: r.Host}
	http.SetCookie(w, &http.Cookie{Name: "lever_hub", Value: token, Path: "/", HttpOnly: true, Secure: r.TLS != nil || !p.Loopback(u.Hostname()), SameSite: http.SameSiteLaxMode, Expires: expires})
	return send(w, true)
}
func (h *Hub) me(w http.ResponseWriter, r *http.Request, a principal) error {
	rows, err := h.db.Query("SELECT s.id,s.name,s.kind FROM spaces s JOIN memberships m ON m.space_id=s.id WHERE m.user_id=? AND (?='' OR s.id=?) ORDER BY s.name", a.user, a.space, a.space)
	if err != nil {
		return err
	}
	defer rows.Close()
	spaces := []p.Space{}
	for rows.Next() {
		var s p.Space
		if err = rows.Scan(&s.ID, &s.Name, &s.Kind); err != nil {
			return err
		}
		spaces = append(spaces, s)
	}
	if err = rows.Err(); err != nil {
		return err
	}
	return send(w, map[string]any{"hub": h.identity, "spaces": spaces, "userId": a.user, "deviceId": a.device, "role": a.role, "sessionId": a.session})
}
func (h *Hub) logout(w http.ResponseWriter, r *http.Request, a principal) error {
	_, err := h.db.Exec("DELETE FROM sessions WHERE id=?", a.session)
	if err != nil {
		return err
	}
	http.SetCookie(w, &http.Cookie{Name: "lever_hub", Value: "", Path: "/", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteLaxMode})
	h.notifyUser(a.user)
	return send(w, true)
}
func (h *Hub) notifyUser(user string) {
	rows, err := h.db.Query("SELECT space_id FROM memberships WHERE user_id=?", user)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var space string
		if rows.Scan(&space) == nil {
			h.notify(space)
		}
	}
}
func (h *Hub) sessions(w http.ResponseWriter, r *http.Request, a principal) error {
	rows, err := h.db.Query("SELECT id,agent,expires FROM sessions WHERE user_id=? AND expires>? ORDER BY expires DESC", a.user, time.Now().Unix())
	if err != nil {
		return err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, agent string
		var exp int64
		if err = rows.Scan(&id, &agent, &exp); err != nil {
			return err
		}
		out = append(out, map[string]any{"id": id, "agent": agent, "expires": exp, "current": id == a.session})
	}
	if err = rows.Err(); err != nil {
		return err
	}
	return send(w, out)
}
func (h *Hub) revokeSession(w http.ResponseWriter, r *http.Request, a principal) error {
	_, err := h.db.Exec("DELETE FROM sessions WHERE user_id=? AND id=?", a.user, r.PathValue("id"))
	if err != nil {
		return err
	}
	h.notifyUser(a.user)
	return send(w, true)
}
func (h *Hub) ticket(w http.ResponseWriter, r *http.Request, a principal) error {
	var in struct {
		Role p.Role `json:"role"`
	}
	if err := read(r, &in); err != nil {
		return err
	}
	if !in.Role.Valid() {
		return invalid("invalid device role")
	}
	var b [8]byte
	rand.Read(b[:])
	code := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(b[:])
	expires := time.Now().Add(10 * time.Minute).Unix()
	_, err := h.db.Exec("INSERT INTO tickets VALUES(?,?,?,?,?)", p.Digest([]byte(code)), r.PathValue("space"), a.user, in.Role, expires)
	if err != nil {
		return err
	}
	return send(w, map[string]any{"code": code, "expires": expires})
}
func (h *Hub) pair(w http.ResponseWriter, r *http.Request, _ principal) error {
	if !h.attempt("pair:" + clientIP(r)) {
		return problem{429, "too many pairing attempts"}
	}
	var in p.PairInput
	if err := read(r, &in); err != nil {
		return err
	}
	if !in.Valid() {
		return invalid("invalid device identity or proof")
	}
	code := strings.ToUpper(strings.TrimSpace(in.Code))
	token := p.Token()
	m := p.Membership{Hub: h.identity, Role: in.Role, DeviceID: in.ID, Token: token}
	err := write(h.db, func(tx *sql.Tx) error {
		var cap p.Role
		if err := tx.QueryRow("DELETE FROM tickets WHERE digest=? AND expires>? RETURNING space_id,user_id,role", p.Digest([]byte(code)), time.Now().Unix()).Scan(&m.SpaceID, &m.UserID, &cap); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return denied
			}
			return err
		}
		if err := tx.QueryRow("SELECT kind FROM spaces WHERE id=?", m.SpaceID).Scan(&m.SpaceKind); err != nil {
			return err
		}
		if cap != in.Role && cap != p.Workstation {
			return denied
		}
		res, err := tx.Exec(`INSERT INTO devices(space_id,id,user_id,name,platform,role,pub,token,seen) VALUES(?,?,?,?,?,?,?,?,?)
ON CONFLICT(space_id,id) DO UPDATE SET token=excluded.token,role=excluded.role,revoked=0,draining=0,seen=excluded.seen
WHERE devices.pub=excluded.pub AND devices.user_id=excluded.user_id`, m.SpaceID, in.ID, m.UserID, in.Name, in.Platform, in.Role, in.PublicKey, p.Digest([]byte(token)), time.Now().Unix())
		if err != nil {
			return err
		}
		n, _ := res.RowsAffected()
		if n != 1 {
			return conflict("device identity already registered")
		}
		return nil
	})
	if err != nil {
		return err
	}
	h.disconnect(deviceKey{m.SpaceID, in.ID})
	h.notify(m.SpaceID)
	return send(w, m)
}
func (h *Hub) devices(w http.ResponseWriter, r *http.Request, a principal) error {
	space := r.PathValue("space")
	var grant p.Grant
	if r.URL.Query().Get("lan") == "1" && a.device != "" {
		grant = p.Grant{HubID: h.identity.ID, SpaceID: space, UserID: a.user, Controller: p.Identity{ID: a.device}, Expires: time.Now().Add(5 * time.Minute).Unix()}
		if err := h.db.QueryRowContext(r.Context(), "SELECT pub,policy FROM devices JOIN spaces ON spaces.id=devices.space_id WHERE space_id=? AND devices.id=? AND token=? AND revoked=0", space, a.device, a.token).Scan(&grant.Controller.PublicKey, &grant.Policy); err != nil {
			return err
		}
	}
	rows, err := h.db.Query("SELECT id,pub,name,platform,role,draining,revoked,seen,version FROM devices WHERE space_id=? ORDER BY name,id", space)
	if err != nil {
		return err
	}
	defer rows.Close()
	type entry struct {
		p.Device
		LANProof string `json:"lanProof,omitempty"`
	}
	out := []entry{}
	for rows.Next() {
		d := p.Device{SpaceID: space}
		if err := rows.Scan(&d.ID, &d.PublicKey, &d.Name, &d.Platform, &d.Role, &d.Draining, &d.Revoked, &d.LastSeen, &d.Version); err != nil {
			return err
		}
		d.Online = !d.Revoked && (h.online(deviceKey{space, d.ID}) || d.Role == p.Controller && time.Since(time.Unix(d.LastSeen, 0)) < 75*time.Second)
		item := entry{Device: d}
		if grant.Controller.ID != "" && !d.Revoked && d.Role.Executes() && d.ID != a.device {
			grant.Host = d.Identity
			grant.Draining = d.Draining
			item.LANProof = p.IssueGrant(grant, h.key)
		}
		out = append(out, item)
	}
	if err = rows.Err(); err != nil {
		return err
	}
	return send(w, out)
}
func (h *Hub) editDevice(w http.ResponseWriter, r *http.Request, _ principal) error {
	var in struct {
		Name     *string `json:"name"`
		Draining *bool   `json:"draining"`
	}
	if err := read(r, &in); err != nil {
		return err
	}
	if in.Name != nil && (strings.TrimSpace(*in.Name) == "" || len(*in.Name) > 160) {
		return invalid("invalid name")
	}
	space := r.PathValue("space")
	res, err := h.db.Exec("UPDATE devices SET name=coalesce(?,name),draining=coalesce(?,draining) WHERE space_id=? AND id=? AND revoked=0", in.Name, in.Draining, space, r.PathValue("id"))
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return sql.ErrNoRows
	}
	h.notify(space)
	return send(w, true)
}
func (h *Hub) revoke(w http.ResponseWriter, r *http.Request, a principal) error {
	space, id := r.PathValue("space"), r.PathValue("id")
	if !a.role.Controls() && id != a.device {
		return denied
	}
	res, err := h.db.Exec("UPDATE devices SET revoked=1,token=NULL WHERE space_id=? AND id=?", space, id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return sql.ErrNoRows
	}
	h.disconnect(deviceKey{space, id})
	h.notify(space)
	return send(w, true)
}
func (h *Hub) events(w http.ResponseWriter, r *http.Request, a principal) error {
	space := r.PathValue("space")
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("X-Accel-Buffering", "no")
	for {
		wake := h.watch(space)
		var allowed bool
		err := h.db.QueryRowContext(r.Context(), `SELECT EXISTS(SELECT 1 FROM memberships WHERE user_id=? AND space_id=?) AND
(EXISTS(SELECT 1 FROM sessions WHERE id=? AND expires>?) OR EXISTS(SELECT 1 FROM devices WHERE space_id=? AND token=? AND revoked=0 AND role IN ('workstation','controller')))`, a.user, space, a.session, time.Now().Unix(), space, a.token).Scan(&allowed)
		if err != nil || !allowed {
			return nil
		}
		if _, err = fmt.Fprint(w, "data: refresh\n\n"); err != nil {
			return nil
		}
		if http.NewResponseController(w).Flush() != nil {
			return nil
		}
		select {
		case <-wake:
		case <-time.After(25 * time.Second):
		case <-r.Context().Done():
			return nil
		}
	}
}
