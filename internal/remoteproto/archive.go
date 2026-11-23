package remoteproto

import (
	"net/url"
	"strconv"
)

// A short interruption replays changed objects. A longer interruption
// replaces the requested index or conversation from an atomic snapshot.
const ArchiveWindow int64 = 512

func ReadCursor(q url.Values) ArchiveCursor {
	v, err := strconv.ParseInt(q.Get("version"), 10, 64)
	if err != nil || v < 0 {
		return ArchiveCursor{}
	}
	return ArchiveCursor{Epoch: q.Get("epoch"), Stream: q.Get("stream"), Version: v}
}
func (c ArchiveCursor) CanReplay(prev ArchiveCursor, floor int64) bool {
	return c.Stream != "" && c.Stream == prev.Stream && c.Epoch == prev.Epoch && prev.Version >= floor && prev.Version <= c.Version
}
func (r Record) InView(chat string) bool {
	if chat == "" {
		return r.Kind == "agent" || r.Kind == "chat" || r.Kind == "session"
	}
	return r.Kind == "chat" && r.ID == chat || r.ChatID == chat
}
