package hub

import (
	"database/sql"
	"encoding/json"
	"net/http"

	p "lever/internal/remoteproto"
)

const archiveView = `((?3='' AND kind IN ('agent','chat','session')) OR (?3<>'' AND ((kind='chat' AND id=?3) OR json_extract(data,'$.chatId')=?3)))`

func trackArchiveView(tx *sql.Tx, a principal, version int64, kind, id, chat string) error {
	var views []string
	switch kind {
	case "agent":
		views = []string{""}
	case "chat":
		views = []string{"", id}
	case "session":
		views = []string{"", chat}
	default:
		views = []string{chat}
	}
	for _, view := range views {
		if _, err := tx.Exec("INSERT INTO archive_updates VALUES(?,?,?,?,?,?) ON CONFLICT(space_id,device_id,view,kind,id) DO UPDATE SET version=excluded.version", a.space, a.device, view, kind, id, version); err != nil {
			return err
		}
	}
	return nil
}

func (h *Hub) archivePage(w http.ResponseWriter, r *http.Request, a principal) error {
	q := r.URL.Query()
	space, host, chat := r.PathValue("space"), r.PathValue("device"), q.Get("chat")
	prev := p.ReadCursor(q)
	page := p.ArchivePage{Changes: []p.Change{}}
	tx, err := h.db.BeginTx(r.Context(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var floor int64
	err = tx.QueryRow(`SELECT d.epoch,d.version,coalesce(s.stream,''),coalesce(s.floor,d.version) FROM devices d LEFT JOIN archive_streams s ON s.space_id=d.space_id AND s.device_id=d.id WHERE d.space_id=? AND d.id=?`, space, host).Scan(&page.Cursor.Epoch, &page.Cursor.Version, &page.Cursor.Stream, &floor)
	if err != nil {
		return err
	}
	if prev.Stream == "lan" && (page.Cursor.Epoch == "" || prev.Epoch == page.Cursor.Epoch && prev.Version > page.Cursor.Version) {
		return conflict("Hub 正在同步手机已从局域网读取的进度")
	}
	cursors, err := loadDeviceReadCursors(tx, space, a.user, host)
	if err != nil {
		return err
	}
	page.Full = !page.Cursor.CanReplay(prev, floor)
	var rows *sql.Rows
	if page.Full {
		rows, err = tx.Query("SELECT kind,id,data FROM archive WHERE space_id=?1 AND device_id=?2 AND "+archiveView+" ORDER BY kind,id", space, host, chat)
	} else {
		rows, err = tx.Query(`SELECT u.kind,u.id,a.data FROM archive_updates u LEFT JOIN archive a USING(space_id,device_id,kind,id)
			WHERE u.space_id=? AND u.device_id=? AND u.view=? AND u.version>? ORDER BY u.version,u.kind,u.id`, space, host, chat, prev.Version)
	}
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var c p.Change
		var raw sql.NullString
		if err = rows.Scan(&c.Kind, &c.ID, &raw); err != nil {
			return err
		}
		if raw.Valid {
			if err = json.Unmarshal([]byte(raw.String), &c.Record); err != nil {
				return err
			}
			if c.Kind == "session" && cursors[c.ID] > c.ReadSequence {
				c.ReadSequence = cursors[c.ID]
			}
		}
		if !raw.Valid || !c.Record.InView(chat) {
			c = p.Change{Record: p.Record{Kind: c.Kind, ID: c.ID}, Deleted: true}
		}
		page.Changes = append(page.Changes, c)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	rows.Close()
	if err := tx.Commit(); err != nil {
		return err
	}
	return send(w, page)
}
