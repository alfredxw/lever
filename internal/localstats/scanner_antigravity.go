package localstats

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"lever/internal/model"
	_ "modernc.org/sqlite"
)

// Offline fallback mapping for Antigravity model enum IDs (cross-checked with t3code/ccusage).
var antigravityModelIDs = map[uint64]string{
	246:  "gemini-2.5-pro",
	312:  "gemini-2.5-flash",
	313:  "gemini-2.5-flash-thinking",
	329:  "gemini-2.5-flash-thinking",
	330:  "gemini-2.5-flash-lite",
	281:  "claude-sonnet-4",
	282:  "claude-sonnet-4",
	290:  "claude-opus-4",
	291:  "claude-opus-4",
	333:  "claude-sonnet-4-5",
	334:  "claude-sonnet-4-5",
	340:  "claude-haiku-4-5",
	341:  "claude-haiku-4-5",
	342:  "gpt-oss-120b-medium",
	1026: "claude-opus-4-6",
	1035: "claude-sonnet-4-6",
	1016: "gemini-3.1-pro",
	1036: "gemini-3.1-pro",
	1037: "gemini-3.1-pro",
	1018: "gemini-3-flash-preview",
	1047: "gemini-3-flash-preview",
	1084: "gemini-3-flash-preview",
	1020: "gemini-3.5-flash-medium",
	1050: "gemini-3.1-flash-lite",
	1132: "gemini-3.5-flash-high",
	1133: "gemini-3.5-flash-high",
	1196: "gemini-3.6-flash",
	1266: "gemini-3.6-flash",
	1402: "claude-opus-5-5",
	1417: "gemini-4-argon",
	1418: "gemini-4-argon",
	1419: "gemini-4-argon",
	1427: "gemini-4-carbon",
	1437: "gemini-4-carbon",
	1525: "gemini-4-hydrogen",
	1526: "gemini-4-hydrogen",
	1527: "gemini-4-hydrogen",
	1532: "gemini-4-neon",
	1533: "gemini-4-neon",
	1537: "gemini-pro-orchestrator-neon",
	1667: "gemini-pro-orchestrator",
	1669: "gemini-4-hydrogen-orchestrator",
}

var (
	agyConcreteModelRe = regexp.MustCompile(`^(?:gemini-\d|claude-(?:sonnet|opus|haiku)-\d|gpt-)`)
	agyClaudeFlipRe    = regexp.MustCompile(`^claude-(\d+(?:\.\d+)?)-(sonnet|opus|haiku)`)
	agyParenSuffixRe   = regexp.MustCompile(`\s*\(([^)]*)\)\s*$`)
)

type pbField struct {
	varint uint64
	bytes  []byte
	isVar  bool
}

type pbFields map[uint64][]pbField

func decodeProtobuf(data []byte) (pbFields, error) {
	out := make(pbFields)
	offset := 0
	readVarint := func() (uint64, error) {
		var val uint64
		for shift := uint(0); shift < 70; shift += 7 {
			if offset >= len(data) {
				return 0, errors.New("truncated varint")
			}
			b := data[offset]
			offset++
			val |= uint64(b&0x7f) << shift
			if b < 0x80 {
				return val, nil
			}
		}
		return 0, errors.New("overflow varint")
	}
	for offset < len(data) {
		tag, err := readVarint()
		if err != nil {
			return nil, err
		}
		num := tag >> 3
		wire := tag & 7
		if num == 0 {
			return nil, errors.New("zero field number")
		}
		switch wire {
		case 0:
			v, err := readVarint()
			if err != nil {
				return nil, err
			}
			out[num] = append(out[num], pbField{varint: v, isVar: true})
		case 1:
			if offset+8 > len(data) {
				return nil, errors.New("truncated fixed64")
			}
			offset += 8
		case 5:
			if offset+4 > len(data) {
				return nil, errors.New("truncated fixed32")
			}
			offset += 4
		case 2:
			length, err := readVarint()
			if err != nil {
				return nil, err
			}
			if length > uint64(len(data)-offset) {
				return nil, errors.New("truncated bytes")
			}
			chunk := make([]byte, length)
			copy(chunk, data[offset:offset+int(length)])
			offset += int(length)
			out[num] = append(out[num], pbField{bytes: chunk})
		default:
			return nil, errors.New("unsupported wire type")
		}
	}
	return out, nil
}

func (f pbFields) num(key uint64) uint64 {
	if list := f[key]; len(list) > 0 && list[0].isVar {
		return list[0].varint
	}
	return 0
}

func (f pbFields) bytes(key uint64) []byte {
	if list := f[key]; len(list) > 0 && !list[0].isVar {
		return list[0].bytes
	}
	return nil
}

func (f pbFields) nested(key uint64) pbFields {
	b := f.bytes(key)
	if len(b) == 0 {
		return nil
	}
	res, err := decodeProtobuf(b)
	if err != nil {
		return nil
	}
	return res
}

func (f pbFields) text(key uint64) string {
	b := f.bytes(key)
	if len(b) == 0 || !utf8.Valid(b) {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func pbTimestamp(f pbFields) (time.Time, bool) {
	if len(f) == 0 {
		return time.Time{}, false
	}
	secs := f.num(1)
	if secs == 0 || secs > 4_000_000_000 {
		return time.Time{}, false
	}
	nanos := f.num(2)
	return time.Unix(int64(secs), int64(nanos)).UTC(), true
}

func normalizeAgyModelName(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	s := strings.ToLower(raw)
	s = agyParenSuffixRe.ReplaceAllString(s, "-$1")
	s = strings.Join(strings.Fields(s), "-")
	if strings.HasPrefix(s, "claude-") {
		s = agyClaudeFlipRe.ReplaceAllString(s, "claude-$2-$1")
		s = strings.ReplaceAll(s, ".", "-")
	}
	return s
}

type agyMetadata struct {
	model   string
	modelID uint64
	ts      time.Time
	hasTS   bool
	usages  []pbFields
}

func decodeAgyMetadata(raw []byte, isStep bool) (agyMetadata, error) {
	root, err := decodeProtobuf(raw)
	if err != nil {
		return agyMetadata{}, err
	}
	data := root
	if !isStep {
		data = root.nested(1)
		if len(data) == 0 {
			return agyMetadata{}, errors.New("missing generation metadata")
		}
	}
	modelNode := data
	if isStep {
		modelNode = data.nested(24)
	}
	usageKey := uint64(4)
	retryKey := uint64(17)
	if isStep {
		usageKey = 9
		retryKey = 28
	}
	var usages []pbFields
	var primary pbFields
	if u := data.nested(usageKey); len(u) > 0 {
		primary = u
		usages = append(usages, u)
	}
	for _, rf := range data[retryKey] {
		if rf.isVar || len(rf.bytes) == 0 {
			continue
		}
		if retryMsg, err := decodeProtobuf(rf.bytes); err == nil {
			if ru := retryMsg.nested(2); len(ru) > 0 {
				usages = append(usages, ru)
			}
		}
	}
	var names []string
	if isStep {
		names = []string{normalizeAgyModelName(modelNode.text(12)), normalizeAgyModelName(modelNode.text(8))}
	} else {
		names = []string{normalizeAgyModelName(modelNode.text(19)), normalizeAgyModelName(modelNode.text(21))}
	}
	chosen := ""
	for _, n := range names {
		if agyConcreteModelRe.MatchString(n) {
			chosen = n
			break
		}
	}
	if chosen == "" {
		for _, n := range names {
			if n != "" && !strings.HasPrefix(n, "model_") && !strings.HasPrefix(n, "model-") {
				chosen = n
				break
			}
		}
	}
	modelID := modelNode.num(3)
	if isStep {
		modelID = modelNode.num(1)
	}
	if modelID == 0 && len(primary) > 0 {
		modelID = primary.num(1)
	}
	var ts time.Time
	var hasTS bool
	if isStep {
		if t, ok := pbTimestamp(data.nested(8)); ok {
			ts, hasTS = t, true
		} else if t, ok := pbTimestamp(data.nested(1)); ok {
			ts, hasTS = t, true
		}
	} else {
		if t, ok := pbTimestamp(data.nested(9).nested(4)); ok {
			ts, hasTS = t, true
		}
	}
	return agyMetadata{model: chosen, modelID: modelID, ts: ts, hasTS: hasTS, usages: usages}, nil
}

func openReadOnlySQLite(path string) (*sql.DB, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	slash := filepath.ToSlash(abs)
	if !strings.HasPrefix(slash, "/") {
		slash = "/" + slash
	}
	uri := url.URL{
		Scheme:   "file",
		Path:     slash,
		RawQuery: "mode=ro&_pragma=busy_timeout(100)&_pragma=query_only(1)",
	}
	db, err := sql.Open("sqlite", uri.String())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	return db, nil
}

type agySummaryMeta struct {
	Title string
	CWD   string
}

// readAntigravitySummaries reads optional conversation_summaries.db to recover titles/workspaces
// for external Antigravity CLI conversations.
func readAntigravitySummaries(ctx context.Context, summaryDBPath string) map[string]agySummaryMeta {
	result := make(map[string]agySummaryMeta)
	db, err := openReadOnlySQLite(summaryDBPath)
	if err != nil {
		return result
	}
	defer db.Close()

	rows, err := db.QueryContext(ctx, "SELECT name FROM sqlite_master WHERE type='table'")
	if err != nil {
		return result
	}
	tables := map[string]bool{}
	for rows.Next() {
		var name string
		if rows.Scan(&name) == nil {
			tables[name] = true
		}
	}
	rows.Close()
	if !tables["conversation_summaries"] {
		return result
	}

	colRows, err := db.QueryContext(ctx, "PRAGMA table_info(conversation_summaries)")
	if err != nil {
		return result
	}
	cols := map[string]bool{}
	for colRows.Next() {
		var cid int
		var name, ctype string
		var notnull int
		var dflt any
		var pk int
		if colRows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk) == nil {
			cols[strings.ToLower(name)] = true
		}
	}
	colRows.Close()

	idCol := "cascade_id"
	if !cols[idCol] {
		if cols["id"] {
			idCol = "id"
		} else if cols["conversation_id"] {
			idCol = "conversation_id"
		} else {
			return result
		}
	}
	titleExpr := "''"
	if cols["summary"] {
		titleExpr = "COALESCE(summary,'')"
	} else if cols["title"] {
		titleExpr = "COALESCE(title,'')"
	}
	cwdExpr := "''"
	if cols["workspace_uris"] {
		cwdExpr = "COALESCE(workspace_uris,'')"
	} else if cols["workspace_path"] {
		cwdExpr = "COALESCE(workspace_path,'')"
	} else if cols["cwd"] {
		cwdExpr = "COALESCE(cwd,'')"
	}

	q := "SELECT " + idCol + ", " + titleExpr + ", " + cwdExpr + " FROM conversation_summaries"
	srows, err := db.QueryContext(ctx, q)
	if err != nil {
		return result
	}
	defer srows.Close()
	for srows.Next() {
		var id, title, rawCWD string
		if srows.Scan(&id, &title, &rawCWD) == nil && id != "" {
			result[id] = agySummaryMeta{Title: trimTitle(title), CWD: extractWorkspacePath(rawCWD)}
		}
	}
	return result
}

func extractWorkspacePath(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	decodeURI := func(s string) string {
		s = strings.TrimSpace(s)
		if strings.HasPrefix(s, "file://") {
			if u, err := url.Parse(s); err == nil && u.Path != "" {
				return u.Path
			}
		}
		return s
	}
	isInternalAuxPath := func(p string) bool {
		return strings.HasSuffix(p, "/agent-skills") ||
			strings.Contains(p, "/.antigravity-probe-") ||
			strings.Contains(p, "/Lever/sessions/")
	}
	if strings.HasPrefix(raw, "[") {
		var uris []string
		if json.Unmarshal([]byte(raw), &uris) == nil && len(uris) > 0 {
			fallback := ""
			for _, u := range uris {
				p := decodeURI(u)
				if p == "" {
					continue
				}
				if !isInternalAuxPath(p) {
					return p
				}
				if fallback == "" {
					fallback = p
				}
			}
			if isInternalAuxPath(fallback) {
				return ""
			}
			return fallback
		}
	}
	p := decodeURI(raw)
	if isInternalAuxPath(p) {
		return ""
	}
	return p
}

func parseAntigravityDB(ctx context.Context, path string, fallbackTime time.Time) (parsedFile, error) {
	db, err := openReadOnlySQLite(path)
	if err != nil {
		return parsedFile{}, err
	}
	defer db.Close()

	rows, err := db.QueryContext(ctx, "SELECT name FROM sqlite_master WHERE type='table'")
	if err != nil {
		return parsedFile{}, err
	}
	tables := map[string]bool{}
	for rows.Next() {
		var name string
		if rows.Scan(&name) == nil {
			tables[name] = true
		}
	}
	rows.Close()
	if !tables["gen_metadata"] && !tables["steps"] {
		return parsedFile{}, nil
	}

	var trajTS time.Time
	var hasTrajTS bool
	if tables["trajectory_metadata_blob"] {
		var raw []byte
		if db.QueryRowContext(ctx, "SELECT data FROM trajectory_metadata_blob LIMIT 1").Scan(&raw) == nil {
			if msg, err := decodeProtobuf(raw); err == nil {
				if t, ok := pbTimestamp(msg.nested(2)); ok {
					trajTS, hasTrajTS = t, true
				}
			}
		}
	}

	type indexedMeta struct {
		idx  int
		meta agyMetadata
	}
	readTable := func(query string, isStep bool) []indexedMeta {
		var list []indexedMeta
		qrows, err := db.QueryContext(ctx, query)
		if err != nil {
			return nil
		}
		defer qrows.Close()
		for qrows.Next() {
			var idx int
			var raw []byte
			if qrows.Scan(&idx, &raw) != nil || len(raw) == 0 {
				continue
			}
			if m, err := decodeAgyMetadata(raw, isStep); err == nil {
				list = append(list, indexedMeta{idx: idx, meta: m})
			}
		}
		return list
	}

	var gens, steps []indexedMeta
	if tables["gen_metadata"] {
		gens = readTable("SELECT idx, data FROM gen_metadata ORDER BY idx", false)
	}
	if tables["steps"] {
		steps = readTable("SELECT idx, metadata FROM steps WHERE metadata IS NOT NULL ORDER BY idx", true)
	}

	learnedModels := make(map[uint64]string)
	genByIdx := make(map[int]agyMetadata, len(gens))
	for _, g := range gens {
		genByIdx[g.idx] = g.meta
		if g.meta.modelID > 0 && agyConcreteModelRe.MatchString(g.meta.model) {
			learnedModels[g.meta.modelID] = g.meta.model
		}
	}
	for _, s := range steps {
		if s.meta.modelID > 0 && agyConcreteModelRe.MatchString(s.meta.model) {
			learnedModels[s.meta.modelID] = s.meta.model
		}
	}

	sessionID := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	var out parsedFile
	dedupeIdx := make(map[string]int)

	collect := func(list []indexedMeta, isStep bool) {
		for _, item := range list {
			for _, u := range item.meta.usages {
				outTok := max(int64(u.num(3)), int64(u.num(9)+u.num(10)))
				totals := computeTotal(model.TokenTotals{
					UncachedInput: int64(u.num(2)),
					CachedInput:   int64(u.num(5)),
					CacheWrite:    int64(u.num(4)),
					Output:        outTok,
					Reasoning:     int64(u.num(9)),
				})
				if totals.Total == 0 {
					continue
				}
				mid := u.num(1)
				if mid == 0 {
					mid = item.meta.modelID
				}
				modelName := ""
				if agyConcreteModelRe.MatchString(item.meta.model) && (mid == 0 || item.meta.modelID == mid) {
					modelName = item.meta.model
				} else if isStep {
					if g, ok := genByIdx[item.idx]; ok && agyConcreteModelRe.MatchString(g.model) && (mid == 0 || g.modelID == mid) {
						modelName = g.model
					}
				}
				if modelName == "" && mid > 0 {
					if m, ok := learnedModels[mid]; ok {
						modelName = m
					} else if m, ok := antigravityModelIDs[mid]; ok {
						modelName = m
					}
				}
				if modelName == "" {
					modelName = item.meta.model
				}
				if modelName == "" {
					modelName = "gemini-3-pro"
				}

				ts := fallbackTime.UTC()
				if item.meta.hasTS {
					ts = item.meta.ts
				} else if hasTrajTS {
					ts = trajTS
				}

				dedupeKey := ""
				for _, k := range []uint64{11, 12, 7} {
					if id := u.text(k); id != "" {
						dedupeKey = "antigravity:" + id
						break
					}
				}
				rec := usageRecord{
					Provider:  "antigravity",
					SessionID: sessionID,
					Model:     modelName,
					Timestamp: ts,
					Totals:    totals,
					DedupeKey: dedupeKey,
				}
				if dedupeKey != "" {
					if idx, ok := dedupeIdx[dedupeKey]; ok {
						prev := &out.Records[idx]
						prev.Totals.UncachedInput = max(prev.Totals.UncachedInput, rec.Totals.UncachedInput)
						prev.Totals.CachedInput = max(prev.Totals.CachedInput, rec.Totals.CachedInput)
						prev.Totals.CacheWrite = max(prev.Totals.CacheWrite, rec.Totals.CacheWrite)
						prev.Totals.Output = max(prev.Totals.Output, rec.Totals.Output)
						prev.Totals.Reasoning = max(prev.Totals.Reasoning, rec.Totals.Reasoning)
						prev.Totals = computeTotal(prev.Totals)
						if agyConcreteModelRe.MatchString(rec.Model) && !agyConcreteModelRe.MatchString(prev.Model) {
							prev.Model = rec.Model
						}
						continue
					}
					dedupeIdx[dedupeKey] = len(out.Records)
				}
				out.Records = append(out.Records, rec)
			}
		}
	}

	collect(steps, true)
	collect(gens, false)
	return out, nil
}
