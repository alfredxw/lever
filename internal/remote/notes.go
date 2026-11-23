package remote

import (
	"context"
	"database/sql"
	"errors"
	"net/url"

	"github.com/google/uuid"
	"lever/internal/notes"
	p "lever/internal/remoteproto"
)

type notePreview struct {
	Assets  int    `json:"assets,omitempty"`
	Title   string `json:"title"`
	Body    string `json:"body"`
	Version string `json:"version"`
	Link    string `json:"link,omitempty"`
}

func (h *Host) note(ctx context.Context, st p.ClientState, in Management) (notePreview, error) {
	var n notePreview
	if !st.Membership.Role.Controls() {
		return n, errors.New("controller role required")
	}
	src, err := h.App.TaskNote(ctx, in.ID)
	if err != nil {
		return n, err
	}
	blocks, _, err := notes.ParseContent(src.Content)
	if err != nil {
		return n, err
	}
	n = notePreview{Title: src.Title, Body: notes.Text(blocks, ""), Version: src.Version}
	var countAssets func([]notes.Node)
	countAssets = func(nodes []notes.Node) {
		for _, v := range nodes {
			if v.Type == "noteAsset" || v.Type == "image" {
				n.Assets++
			}
			countAssets(v.Content)
		}
	}
	countAssets(blocks)
	var taskID string
	err = h.App.Store.DB.QueryRowContext(ctx, "SELECT task_id FROM remote_note_tasks WHERE note_id=? AND hub=? AND space=?", in.ID, in.Scope.HubID, in.Scope.SpaceID).Scan(&taskID)
	link := func(id string) string {
		return st.Origin + "/s/" + url.PathEscape(in.Scope.SpaceID) + "/tasks/" + url.PathEscape(id)
	}
	if err == nil {
		n.Link = link(taskID)
		return n, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return n, err
	}
	if in.Action == "preview_note" {
		return n, nil
	}
	if in.NoteVersion != src.Version {
		return n, errors.New("笔记已更新，请重新预览")
	}
	// The Hub can commit before the local link is saved. Both attempts must
	// use the same creation ID, including after a Host restart.
	id := uuid.NewSHA1(uuid.NameSpaceURL, []byte(in.Scope.HubID+"/"+in.Scope.SpaceID+"/"+st.Membership.DeviceID+"/"+src.ID)).String()
	var task p.Task
	if err = st.Do(ctx, "POST", st.SpacePath()+"/tasks", map[string]string{"id": id, "title": n.Title, "body": n.Body}, &task); err != nil {
		return n, err
	}
	_, err = h.App.Store.DB.ExecContext(ctx, "INSERT OR IGNORE INTO remote_note_tasks VALUES(?,?,?,?)", in.ID, in.Scope.HubID, in.Scope.SpaceID, task.ID)
	if err != nil {
		return n, err
	}
	n.Link = link(task.ID)
	return n, nil
}
