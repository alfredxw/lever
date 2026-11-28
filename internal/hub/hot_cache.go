package hub

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/hashicorp/yamux"
	"lever/internal/model"
	p "lever/internal/remoteproto"
)

// Checkpoint notifications carry only a revision. Read the native pages on
// separate tunnel streams so even a long completed reply cannot block presence.
func (h *Hub) warmNode(ctx context.Context, k deviceKey, user string, l *link, tunnel *yamux.Session) {
	transport := &http.Transport{DisableKeepAlives: true, DialContext: func(context.Context, string, string) (net.Conn, error) { return tunnel.Open() }}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 40 * time.Second, CheckRedirect: p.Client.CheckRedirect}
	for ctx.Err() == nil {
		err := h.refreshHot(ctx, k, user, l.generation, client)
		var retry <-chan time.Time
		if err != nil {
			retry = time.After(5 * time.Second)
		}
		select {
		case <-ctx.Done():
			return
		case <-l.ended:
			return
		case <-l.checkpoint:
		case <-retry:
		}
	}
}

func fetchHot(ctx context.Context, client *http.Client, user, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, "GET", "http://owner/peer/v1/"+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("X-Lever-Actor-User", user)
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return errors.New(resp.Status)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

func (h *Hub) refreshHot(ctx context.Context, k deviceKey, user string, generation int64, client *http.Client) error {
	var state string
	if err := h.db.QueryRowContext(ctx, "SELECT node FROM devices WHERE space_id=? AND id=? AND generation=? AND revoked=0", k.space, k.device, generation).Scan(&state); err != nil {
		return err
	}
	var n p.NodeDescriptor
	if json.Unmarshal([]byte(state), &n) != nil || !n.Supports(p.FeatureHotCache) || n.CacheEpoch == "" {
		return nil
	}
	var index p.CacheIndex
	if err := fetchHot(ctx, client, user, "cache/index", &index); err != nil {
		return err
	}
	if index.Node.CacheEpoch != n.CacheEpoch || index.Node.NodeID != k.device || !bytes.Equal(n.PublicKey, index.Node.PublicKey) {
		return nil
	}
	// Key pages by chat revision so titles and read state do not cause unrelated
	// multi-megabyte conversations to be fetched again.
	known := map[string]int64{}
	rows, err := h.db.QueryContext(ctx, "SELECT path,revision FROM node_hot_pages WHERE space_id=? AND device_id=? AND epoch=?", k.space, k.device, n.CacheEpoch)
	if err != nil {
		return err
	}
	for rows.Next() {
		var path string
		var rev int64
		if err = rows.Scan(&path, &rev); err != nil {
			rows.Close()
			return err
		}
		known[path] = rev
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	var lastCursor int64
	if known["overview"] != 0 {
		if err = h.db.QueryRowContext(ctx, "SELECT coalesce(json_extract(data,'$.cursor'),0) FROM node_hot_pages WHERE space_id=? AND device_id=? AND path='overview' AND epoch=?", k.space, k.device, n.CacheEpoch).Scan(&lastCursor); err != nil {
			return err
		}
	}
	save := func(path string, rev int64, v any, notices []p.Record, progress ...p.Record) error {
		raw, err := json.Marshal(v)
		if err != nil {
			return err
		}
		return write(h.db, func(tx *sql.Tx) error {
			result, err := tx.ExecContext(ctx, `INSERT INTO node_hot_pages(space_id,device_id,path,epoch,revision,data)
			SELECT space_id,id,?,?,?,? FROM devices WHERE space_id=? AND id=? AND generation=? AND revoked=0 AND json_extract(node,'$.cacheEpoch')=?
			ON CONFLICT(space_id,device_id,path) DO UPDATE SET epoch=excluded.epoch,revision=excluded.revision,data=excluded.data`, path, n.CacheEpoch, rev, raw, k.space, k.device, generation, n.CacheEpoch)
			if err != nil {
				return err
			}
			updated, err := result.RowsAffected()
			if err != nil || updated == 0 {
				return err
			}
			for _, r := range progress {
				if err = queueLiveActivity(tx, k.space, k.device, path, r); err != nil {
					return err
				}
			}
			for _, r := range notices {
				if err = h.queuePagePush(tx, principal{space: k.space, device: k.device, user: user}, r, path); err != nil {
					return err
				}
			}
			return nil
		})
	}
	// Do not replay old results on first pairing. Explicitly shared legacy
	// chats already use their archive outbox. For an ordinary personal chat
	// the durable native page supplies delivery-time visibility and status.
	publicChats := map[string]bool{}
	for _, c := range index.Chats {
		publicChats[c.ID] = c.SharedScope == nil
	}
	conversations := map[string]model.Conversation{}
	for _, c := range index.Conversations {
		conversations[c.ID] = c
	}
	notices := func(runs []model.Run, requests []model.Request, topic bool) []p.Record {
		var result []p.Record
		changed := map[string]bool{}
		for _, run := range runs {
			session := conversations[run.SessionID]
			if !publicChats[run.ChatID] || (session.Kind == "topic") != topic || known["overview"] == 0 || run.UnreadSequence <= max(lastCursor, session.ReadSequence) {
				continue
			}
			changed[run.ID] = true
			if r := (p.Record{Kind: "run", ID: run.ID, ChatID: run.ChatID, Status: run.Status, Superseded: run.Superseded}); noticeKind(r) != "" {
				result = append(result, r)
			}
		}
		for _, q := range requests {
			if changed[q.RunID] && q.Status == "pending" {
				result = append(result, p.Record{Kind: "request", ID: q.ID, ChatID: q.ChatID, Status: q.Status})
			}
		}
		return result
	}
	// Keep the currently displayed sessions fresh even when forty newer chats
	// would otherwise evict them. The Owner index still determines visibility.
	tracked := map[string]bool{}
	active, err := h.db.QueryContext(ctx, "SELECT DISTINCT session FROM live_activities WHERE space=? AND host=? AND expires>unixepoch()", k.space, k.device)
	if err != nil {
		return err
	}
	for active.Next() {
		var session string
		if err = active.Scan(&session); err != nil {
			active.Close()
			return err
		}
		tracked[session] = true
	}
	err = active.Err()
	active.Close()
	if err != nil {
		return err
	}
	trackedChats := map[string]bool{}
	for session := range tracked {
		if s, ok := conversations[session]; ok {
			trackedChats[s.ChatID] = true
		}
	}
	wanted := map[string]bool{"overview": true}
	for i, chat := range index.Chats {
		if i >= 40 && !trackedChats[chat.ID] {
			continue
		}
		path := "chats/" + url.PathEscape(chat.ID)
		wanted[path] = true
		rev := index.Revisions[chat.ID]
		if known[path] == rev && rev != 0 {
			continue
		}
		var page model.ChatView
		if err = fetchHot(ctx, client, user, path+"?limit=40", &page); err != nil {
			return err
		}
		progress := liveRunRecords(page.Runs, page.Requests)
		for i := range page.Runs {
			p.HotRun(&page.Runs[i])
		}
		for i := range page.Sessions {
			page.Sessions[i].Scope = model.Scope{}
		}
		if err = save(path, rev, page, notices(page.Runs, page.Requests, false), progress...); err != nil {
			return err
		}
	}
	slices.SortStableFunc(index.Conversations, func(a, b model.Conversation) int { return strings.Compare(b.MessageAt, a.MessageAt) })
	topicCount := 0
	for _, s := range index.Conversations {
		if s.Kind != "topic" || !wanted["chats/"+s.ChatID] {
			continue
		}
		if topicCount >= 40 && !tracked[s.ID] {
			continue
		}
		topicCount++
		path := "sessions/" + url.PathEscape(s.ID) + "/runs"
		wanted[path] = true
		rev := index.Revisions[s.ChatID]
		if known[path] == rev && rev != 0 {
			continue
		}
		var page struct {
			model.SessionRuns
			Requests []model.Request `json:"requests"`
		}
		if err = fetchHot(ctx, client, user, path+"?limit=40", &page); err != nil {
			return err
		}
		progress := liveRunRecords(page.Runs, page.Requests)
		for i := range page.Runs {
			p.HotRun(&page.Runs[i])
		}
		if err = save(path, rev, page, notices(page.Runs, page.Requests, true), progress...); err != nil {
			return err
		}
	}
	for path := range known {
		if !wanted[path] {
			if _, err = h.db.ExecContext(ctx, "DELETE FROM node_hot_pages WHERE space_id=? AND device_id=? AND epoch=? AND path=? AND revision=?", k.space, k.device, n.CacheEpoch, path, known[path]); err != nil {
				return err
			}
		}
	}
	if known["overview"] != index.Node.CacheRevision {
		view := index.NodeOverview
		view.Node.Online = false
		return save("overview", index.Node.CacheRevision, view, nil)
	}
	return nil
}

func (h *Hub) cachedNode(w http.ResponseWriter, r *http.Request, k deviceKey, n p.NodeDescriptor) error {
	path := r.PathValue("route")
	if path != "overview" && !strings.HasPrefix(path, "chats/") && !(strings.HasPrefix(path, "sessions/") && strings.HasSuffix(path, "/runs")) {
		return problem{503, "target device is offline"}
	}
	var data []byte
	err := h.db.QueryRowContext(r.Context(), "SELECT data FROM node_hot_pages WHERE space_id=? AND device_id=? AND path=? AND epoch=?", k.space, k.device, path, n.CacheEpoch).Scan(&data)
	if errors.Is(err, sql.ErrNoRows) {
		return problem{503, "设备离线，此会话没有可用缓存"}
	}
	if err != nil {
		return err
	}
	data, err = p.SliceCachedPage(data, path, r.URL.Query())
	if err != nil {
		var he *p.HTTPError
		if errors.As(err, &he) {
			return problem{he.Status, he.Message}
		}
		return err
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Lever-Source", "cache")
	_, err = w.Write(data)
	return err
}
