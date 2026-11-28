package remoteproto

import (
	"encoding/json"
	"net/url"
	"slices"
	"strconv"
	"strings"

	"lever/internal/model"
)

// HotRun retains completed content and marks the result of a disconnected
// active turn as unknown until the Owner confirms it.
func HotRun(run *model.Run) {
	run.Changes = nil
	run.TurnDiff = nil
	run.ChannelContext = ""
	run.ChannelPrompt = ""
	run.ScopePaths = nil
	run.NativeTurnID = nil
	if model.Active(run.Status) {
		run.Items = nil
		run.Status = "unverifiable"
	}
}

// SliceCachedPage serves one bounded source for offline history on a Hub or a
// directly paired workstation. Earlier cursors require the Owner to be online.
func SliceCachedPage(data []byte, path string, params url.Values) ([]byte, error) {
	var before int64
	if raw := params.Get("before"); raw != "" {
		var err error
		before, err = strconv.ParseInt(raw, 10, 64)
		if err != nil || before < 0 {
			return nil, &HTTPError{Status: 400, Message: "invalid page cursor"}
		}
	}
	size := 40
	if limit := params.Get("limit"); limit != "" {
		var err error
		size, err = strconv.Atoi(limit)
		if err != nil || size < 1 || size > 40 {
			return nil, &HTTPError{Status: 400, Message: "invalid page size"}
		}
	}
	var err error
	if (size < 40 || before > 0) && path != "overview" {
		if strings.HasPrefix(path, "chats/") {
			var page model.ChatView
			if err = json.Unmarshal(data, &page); err != nil {
				return nil, err
			}
			if before > 0 {
				if len(page.Entries) == 0 || before <= page.Entries[0].Sequence {
					return nil, &HTTPError{Status: 503, Message: "设备离线，上线后可加载更早历史"}
				}
				page.Entries = slices.DeleteFunc(page.Entries, func(e model.TimelineEntry) bool { return e.Sequence >= before })
			}
			if len(page.Entries) > size {
				page.Entries = page.Entries[len(page.Entries)-size:]
				page.HasMore = true
			}
			runs, sessions, comparisons := map[string]bool{}, map[string]bool{}, map[string]bool{}
			for _, e := range page.Entries {
				runs[e.RunID] = true
				sessions[e.SessionID] = true
				comparisons[e.ComparisonID] = true
			}
			page.Runs = slices.DeleteFunc(page.Runs, func(r model.Run) bool { return !runs[r.ID] })
			page.Sessions = slices.DeleteFunc(page.Sessions, func(s model.Session) bool { return s.Kind != "main" && !sessions[s.ID] })
			page.Comparisons = slices.DeleteFunc(page.Comparisons, func(c model.Comparison) bool { return !comparisons[c.ID] })
			page.Requests = slices.DeleteFunc(page.Requests, func(q model.Request) bool { return q.Status != "pending" && !runs[q.RunID] })
			data, err = json.Marshal(page)
		} else {
			var page struct {
				model.SessionRuns
				Requests []model.Request `json:"requests"`
			}
			if err = json.Unmarshal(data, &page); err != nil {
				return nil, err
			}
			if before > 0 {
				if len(page.Runs) == 0 || before <= page.Runs[len(page.Runs)-1].Sequence {
					return nil, &HTTPError{Status: 503, Message: "设备离线，上线后可加载更早历史"}
				}
				page.Runs = slices.DeleteFunc(page.Runs, func(r model.Run) bool { return r.Sequence >= before })
			}
			page.Runs = page.Runs[:min(len(page.Runs), size)]
			page.Requests = slices.DeleteFunc(page.Requests, func(q model.Request) bool {
				return q.Status != "pending" && !slices.ContainsFunc(page.Runs, func(run model.Run) bool { return run.ID == q.RunID })
			})
			data, err = json.Marshal(page)
		}
		if err != nil {
			return nil, err
		}
	}
	return data, nil
}
