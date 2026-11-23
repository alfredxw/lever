package remote

import (
	"context"
	"database/sql"
	"errors"

	p "lever/internal/remoteproto"
)

func (h *Host) archivePage(ctx context.Context, m p.Membership, chat string, prev p.ArchiveCursor) (p.ArchivePage, error) {
	page := p.ArchivePage{Cursor: p.ArchiveCursor{Stream: "lan"}, Changes: []p.Change{}}
	tx, err := h.App.Store.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return page, err
	}
	defer tx.Rollback()
	var floor int64
	err = tx.QueryRowContext(ctx, "SELECT epoch,version,coalesce(floor,0) FROM remote_memberships LEFT JOIN remote_replay_bounds USING(hub,space) WHERE hub=? AND space=?", m.Hub.ID, m.SpaceID).Scan(&page.Cursor.Epoch, &page.Cursor.Version, &floor)
	if err != nil {
		return page, err
	}
	page.Full = !page.Cursor.CanReplay(prev, floor)
	if page.Full {
		rows, err := readLANArchive(ctx, tx, m, chat, "")
		for _, r := range rows {
			page.Changes = append(page.Changes, p.Change{Record: r})
		}
		return page, err
	}
	if prev.Version == page.Cursor.Version {
		return page, nil
	}
	rows, err := tx.QueryContext(ctx, `SELECT kind,object_id FROM shared_sync_log WHERE hub=?1 AND space=?2 AND version>?3 AND
	((?4='' AND kind IN ('agent','session','chat')) OR (?4<>'' AND chat_id=?4)) ORDER BY version`,
		m.Hub.ID, m.SpaceID, prev.Version, chat)
	if err != nil {
		return page, err
	}
	defer rows.Close()
	for rows.Next() {
		var o object
		if err := rows.Scan(&o.kind, &o.id); err != nil {
			return page, err
		}
		r, err := project(ctx, tx, m, o, "")
		if errors.Is(err, sql.ErrNoRows) {
			page.Changes = append(page.Changes, p.Change{Record: p.Record{ID: o.id, Kind: o.kind}, Deleted: true})
			continue
		}
		if err != nil {
			return page, err
		}
		if r.InView(chat) {
			page.Changes = append(page.Changes, p.Change{Record: r})
		}
	}
	return page, rows.Err()
}
