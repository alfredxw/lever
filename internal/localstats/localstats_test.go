package localstats

import (
	"context"
	"database/sql"
	"encoding/binary"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"

	"lever/internal/model"
	"lever/internal/store"

	_ "modernc.org/sqlite"
)

func TestPricingAndSavings(t *testing.T) {
	totals := computeTotal(model.TokenTotals{
		UncachedInput: 100_000,
		CachedInput:   900_000,
		CacheWrite:    200_000,
		Output:        50_000,
	})
	cost, cat, savings, priced := EstimateCost("claude-sonnet-4-6", totals, 50_000, nil)
	if !priced {
		t.Fatalf("expected claude-sonnet-4-6 to be priced")
	}
	// Input: 0.1M * $3 = $0.30
	// CacheRead: 0.9M * $0.30 = $0.27
	// CacheWrite: 0.15M * $3.75 + 0.05M * $6.0 = $0.5625 + $0.30 = $0.8625
	// Output: 0.05M * $15 = $0.75
	wantCost := 0.30 + 0.27 + 0.8625 + 0.75
	if math.Abs(cost-wantCost) > 1e-6 {
		t.Fatalf("cost = %v, want %v", cost, wantCost)
	}
	if math.Abs((cat.Input+cat.CacheRead+cat.CacheWrite+cat.Output)-cost) > 1e-6 {
		t.Fatalf("category sum %+v != cost %v", cat, cost)
	}
	// Savings: 0.9M * ($3 - $0.30) = $2.43
	if math.Abs(savings-2.43) > 1e-6 {
		t.Fatalf("savings = %v, want 2.43", savings)
	}

	// Reported cost overrides computed total while preserving category ratio.
	rep := 5.0
	cost2, _, _, priced2 := EstimateCost("unknown-future-model", totals, 0, &rep)
	if !priced2 || math.Abs(cost2-5.0) > 1e-6 {
		t.Fatalf("reported cost override failed: cost=%v priced=%v", cost2, priced2)
	}
}

func TestParseClaudeFile(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "sess-1.jsonl")
	now := time.Now().UTC().Truncate(time.Second)
	ts := now.Format(time.RFC3339)

	lines := []string{
		`{"type":"user","timestamp":"` + ts + `","sessionId":"s-claude","cwd":"/tmp/demo-repo","message":{"role":"user","content":"Implement local usage stats"}}`,
		// Streaming partial chunk followed by final chunk with same messageId + requestId
		`{"type":"assistant","timestamp":"` + ts + `","sessionId":"s-claude","requestId":"req-1","message":{"id":"msg-1","model":"claude-opus-4-6","usage":{"input_tokens":100,"cache_read_input_tokens":500,"cache_creation_input_tokens":200,"output_tokens":20}}}`,
		`{"type":"assistant","timestamp":"` + ts + `","sessionId":"s-claude","requestId":"req-1","message":{"id":"msg-1","model":"claude-opus-4-6","usage":{"input_tokens":100,"cache_read_input_tokens":500,"cache_creation_input_tokens":200,"output_tokens":80,"cache_creation":{"ephemeral_1h_input_tokens":50},"iterations":[{"type":"advisor_message","model":"claude-sonnet-4-6","input_tokens":10,"cache_read_input_tokens":40,"cache_creation_input_tokens":0,"output_tokens":15}]}}}`,
		// Synthetic must be ignored
		`{"type":"assistant","timestamp":"` + ts + `","sessionId":"s-claude","requestId":"req-2","message":{"id":"msg-2","model":"<synthetic>","usage":{"input_tokens":999,"output_tokens":999}}}`,
	}
	if err := os.WriteFile(p, []byte(joinLines(lines)), 0o600); err != nil {
		t.Fatal(err)
	}

	pf, err := parseClaudeFile(p)
	if err != nil {
		t.Fatal(err)
	}
	if pf.Title != "Implement local usage stats" {
		t.Fatalf("title = %q", pf.Title)
	}
	if pf.CWD != "/tmp/demo-repo" {
		t.Fatalf("cwd = %q", pf.CWD)
	}
	if len(pf.Records) != 2 {
		t.Fatalf("records = %d, want 2 (1 merged main + 1 advisor)", len(pf.Records))
	}
	main := pf.Records[0]
	if main.Totals.Output != 80 || main.Totals.Total != 880 || main.CacheWrite1h != 50 {
		t.Fatalf("unexpected merged main record: %+v", main)
	}
	adv := pf.Records[1]
	if adv.Model != "claude-sonnet-4-6" || adv.Totals.Total != 65 {
		t.Fatalf("unexpected advisor record: %+v", adv)
	}
}

func TestParseCodexFile(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "rollout-2026-11-27.jsonl")
	t0 := time.Now().UTC().Add(-2 * time.Minute).Truncate(time.Second)
	t1 := t0.Add(10 * time.Second)
	t2 := t0.Add(20 * time.Second)

	lines := []string{
		`{"timestamp":"` + t0.Format(time.RFC3339) + `","type":"session_meta","payload":{"id":"codex-sess-1","cwd":"/tmp/codex-proj"}}`,
		`{"timestamp":"` + t0.Format(time.RFC3339) + `","type":"turn_context","payload":{"model":"gpt-5.4","cwd":"/tmp/codex-proj"}}`,
		`{"timestamp":"` + t0.Format(time.RFC3339) + `","type":"event_msg","payload":{"type":"user_message","message":"Optimize scanner cache"}}`,
		// Cumulative token_count #1: input=1000 (includes 600 cached + 100 write => 300 uncached), output=120
		`{"timestamp":"` + t1.Format(time.RFC3339) + `","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1000,"cached_input_tokens":600,"cache_write_input_tokens":100,"output_tokens":120,"reasoning_output_tokens":40}}}}`,
		// Cumulative token_count #2: delta input=500 (cached=400 => uncached=100), output=80
		`{"timestamp":"` + t2.Format(time.RFC3339) + `","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1500,"cached_input_tokens":1000,"cache_write_input_tokens":100,"output_tokens":200,"reasoning_output_tokens":60}}}}`,
	}
	if err := os.WriteFile(p, []byte(joinLines(lines)), 0o600); err != nil {
		t.Fatal(err)
	}

	pf, err := parseCodexFile(p)
	if err != nil {
		t.Fatal(err)
	}
	if pf.Title != "Optimize scanner cache" {
		t.Fatalf("title = %q", pf.Title)
	}
	if len(pf.Records) != 2 {
		t.Fatalf("records = %d, want 2", len(pf.Records))
	}
	r1, r2 := pf.Records[0], pf.Records[1]
	if r1.Totals.UncachedInput != 300 || r1.Totals.CachedInput != 600 || r1.Totals.CacheWrite != 100 || r1.Totals.Output != 120 {
		t.Fatalf("r1 totals = %+v", r1.Totals)
	}
	if r2.Totals.UncachedInput != 100 || r2.Totals.CachedInput != 400 || r2.Totals.CacheWrite != 0 || r2.Totals.Output != 80 {
		t.Fatalf("r2 totals = %+v", r2.Totals)
	}
}

func TestParsePiFile(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "pi-sess.jsonl")
	ts := time.Now().UTC().Truncate(time.Second).Format(time.RFC3339)
	lines := []string{
		`{"type":"session","id":"pi-s1","cwd":"/tmp/pi-app","timestamp":"` + ts + `"}`,
		`{"type":"message","timestamp":"` + ts + `","message":{"role":"user","content":"Audit API latency"}}`,
		`{"type":"message","timestamp":"` + ts + `","message":{"role":"assistant","model":"deepseek-r1","usage":{"input":400,"output":150,"cacheRead":2000,"cacheWrite":100,"cost":{"total":0.042}}}}`,
	}
	if err := os.WriteFile(p, []byte(joinLines(lines)), 0o600); err != nil {
		t.Fatal(err)
	}
	pf, err := parsePiFile(p)
	if err != nil {
		t.Fatal(err)
	}
	if len(pf.Records) != 1 {
		t.Fatalf("records = %d, want 1", len(pf.Records))
	}
	r := pf.Records[0]
	if r.Model != "deepseek-r1" || r.Totals.Total != 2650 || r.ReportedCost == nil || math.Abs(*r.ReportedCost-0.042) > 1e-6 {
		t.Fatalf("unexpected pi record: %+v", r)
	}
}

func TestParseAntigravityDB(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "agy-conv-1.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB); CREATE TABLE trajectory_metadata_blob (data BLOB);`); err != nil {
		t.Fatal(err)
	}
	tsSec := uint64(time.Now().UTC().Truncate(time.Second).Unix())
	// Build Usage protobuf: field 1=modelID(1036), field 2=uncachedInput(400), field 3=output(300), field 4=cacheWrite(100), field 5=cacheRead(2000), field 7=responseID("resp-1")
	usageMsg := concatPB(
		pbVarint(1, 1036),
		pbVarint(2, 400),
		pbVarint(3, 300),
		pbVarint(4, 100),
		pbVarint(5, 2000),
		pbBytes(7, []byte("resp-1")),
	)
	tsMsg := pbVarint(1, tsSec)
	metaField9 := pbBytes(4, tsMsg)
	inner := concatPB(
		pbVarint(3, 1036),
		pbBytes(4, usageMsg),
		pbBytes(9, metaField9),
		pbBytes(19, []byte("gemini-3.1-pro")),
	)
	outer := pbBytes(1, inner)

	if _, err := db.Exec(`INSERT INTO gen_metadata (idx, data) VALUES (1, ?)`, outer); err != nil {
		t.Fatal(err)
	}
	db.Close()

	pf, err := parseAntigravityDB(context.Background(), dbPath, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(pf.Records) != 1 {
		t.Fatalf("records = %d, want 1", len(pf.Records))
	}
	r := pf.Records[0]
	if r.Model != "gemini-3.1-pro" {
		t.Fatalf("unexpected model: %+v", r)
	}
	if r.Totals.UncachedInput != 400 || r.Totals.CachedInput != 2000 || r.Totals.CacheWrite != 100 || r.Totals.Output != 300 || r.Totals.Total != 2800 {
		t.Fatalf("unexpected totals: %+v", r.Totals)
	}
}

func TestServiceStatsAndCorrelation(t *testing.T) {
	tmp := t.TempDir()
	stateDir := filepath.Join(tmp, "lever-state")
	repoDir := filepath.Join(tmp, "my-git-repo")
	if err := os.MkdirAll(filepath.Join(repoDir, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}

	claudeDir := filepath.Join(tmp, "claude")
	codexDir := filepath.Join(tmp, "codex")
	geminiDir := filepath.Join(tmp, "gemini")
	piDir := filepath.Join(tmp, "pi")
	t.Setenv("CLAUDE_CONFIG_DIR", claudeDir)
	t.Setenv("CODEX_HOME", codexDir)
	t.Setenv("GEMINI_HOME", geminiDir)
	t.Setenv("PI_CODING_AGENT_DIR", piDir)

	st, err := store.Open(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	now := time.Now().UTC().Truncate(time.Second)
	yesterday := now.Add(-24 * time.Hour)

	// Seed Lever DB with 1 project, 1 agent, 1 chat, 1 session matching Claude nativeId, 2 runs with diffs
	proj := model.Project{
		ID:   "p1",
		Name: "lever-demo",
		Scope: model.Scope{
			PrimaryRootID: "r1",
			Roots:         []model.Root{{ID: "r1", Path: repoDir}},
		},
	}
	agent := model.Agent{
		ID:     "a1",
		Name:   "Architect",
		Avatar: &model.Avatar{Kind: "monogram", Value: "AR", Color: "amber"},
		Profile: model.Profile{
			ProjectID: "p1",
		},
	}
	chat := model.Chat{ID: "c1", AgentID: "a1", Title: "Build Local Stats"}
	sess := model.Session{
		ID:        "ls1",
		ChatID:    "c1",
		AgentID:   "a1",
		ProjectID: "p1",
		Selection: model.Selection{Provider: "claude"},
		NativeID:  "native-claude-1",
		Title:     "Build Local Stats",
	}
	run1 := map[string]any{
		"id": "run1", "sessionId": "ls1", "createdAt": now.Format(time.RFC3339),
		"changes": []model.RunChanges{{Files: []model.DiffFile{{Path: "a.go", Additions: 120, Deletions: 30}}}},
	}
	run2 := map[string]any{
		"id": "run2", "sessionId": "ls1", "createdAt": yesterday.Format(time.RFC3339),
		"changes": []model.RunChanges{{Files: []model.DiffFile{{Path: "b.go", Additions: 40, Deletions: 10}}}},
	}

	mustInsert := func(sqlStmt string, args ...any) {
		t.Helper()
		if _, err := st.DB.Exec(sqlStmt, args...); err != nil {
			t.Fatalf("exec %s: %v", sqlStmt, err)
		}
	}
	mustJSON := func(v any) string {
		b, _ := json.Marshal(v)
		return string(b)
	}
	mustInsert(`INSERT INTO projects (id, data) VALUES (?, ?)`, proj.ID, mustJSON(proj))
	mustInsert(`INSERT INTO agents (id, data) VALUES (?, ?)`, agent.ID, mustJSON(agent))
	mustInsert(`INSERT INTO chats (id, agent_id, data) VALUES (?, ?, ?)`, chat.ID, chat.AgentID, mustJSON(chat))
	mustInsert(`INSERT INTO sessions (id, chat_id, kind, data) VALUES (?, ?, 'main', ?)`, sess.ID, sess.ChatID, mustJSON(sess))
	mustInsert(`INSERT INTO runs (id, session_id, chat_id, agent_id, command_id, input_hash, status, data) VALUES (?, ?, ?, ?, ?, ?, 'done', ?)`, "run1", "ls1", "c1", "a1", "cmd1", "h1", mustJSON(run1))
	mustInsert(`INSERT INTO runs (id, session_id, chat_id, agent_id, command_id, input_hash, status, data) VALUES (?, ?, ?, ?, ?, ?, 'done', ?)`, "run2", "ls1", "c1", "a1", "cmd2", "h2", mustJSON(run2))

	// Write Lever-correlated Claude session (2 assistant calls)
	if err := os.MkdirAll(filepath.Join(claudeDir, "projects", "demo"), 0o755); err != nil {
		t.Fatal(err)
	}
	claudeFile := filepath.Join(claudeDir, "projects", "demo", "native-claude-1.jsonl")
	claudeLines := []string{
		`{"type":"assistant","timestamp":"` + now.Format(time.RFC3339) + `","sessionId":"native-claude-1","cwd":"` + repoDir + `","requestId":"r1","message":{"id":"m1","model":"claude-opus-4-6","usage":{"input_tokens":1000,"cache_read_input_tokens":9000,"cache_creation_input_tokens":500,"output_tokens":300}}}`,
		`{"type":"assistant","timestamp":"` + yesterday.Format(time.RFC3339) + `","sessionId":"native-claude-1","cwd":"` + repoDir + `","requestId":"r2","message":{"id":"m2","model":"claude-opus-4-6","usage":{"input_tokens":500,"cache_read_input_tokens":4500,"cache_creation_input_tokens":0,"output_tokens":200}}}`,
	}
	if err := os.WriteFile(claudeFile, []byte(joinLines(claudeLines)), 0o600); err != nil {
		t.Fatal(err)
	}

	// Write external Codex CLI session in the SAME git repo (must unify under lever-demo project!)
	if err := os.MkdirAll(filepath.Join(codexDir, "sessions", "2026"), 0o755); err != nil {
		t.Fatal(err)
	}
	codexFile := filepath.Join(codexDir, "sessions", "2026", "rollout-ext.jsonl")
	codexLines := []string{
		`{"timestamp":"` + now.Format(time.RFC3339) + `","type":"session_meta","payload":{"id":"ext-codex-1","cwd":"` + repoDir + `"}}`,
		`{"timestamp":"` + now.Format(time.RFC3339) + `","type":"turn_context","payload":{"model":"gpt-5.4","cwd":"` + repoDir + `"}}`,
		`{"timestamp":"` + now.Format(time.RFC3339) + `","type":"event_msg","payload":{"type":"user_message","message":"CLI quick fix"}}`,
		`{"timestamp":"` + now.Format(time.RFC3339) + `","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":2000,"cached_input_tokens":1500,"output_tokens":400}}}}`,
	}
	if err := os.WriteFile(codexFile, []byte(joinLines(codexLines)), 0o600); err != nil {
		t.Fatal(err)
	}

	svc := NewService(st.DB, stateDir)
	statsAll, err := svc.Stats(context.Background(), Query{Period: "7d", Scope: "all", TimeZone: "UTC", Refresh: true})
	if err != nil {
		t.Fatal(err)
	}

	// Total tokens = (1000+9000+500+300) + (500+4500+200) + (500+1500+400) = 10800 + 5200 + 2400 = 18400
	if statsAll.Totals.Total != 18400 {
		t.Fatalf("total tokens = %d, want 18400", statsAll.Totals.Total)
	}
	if statsAll.LeverTokens != 16000 || statsAll.ExternalTokens != 2400 {
		t.Fatalf("lever=%d ext=%d, want 16000/2400", statsAll.LeverTokens, statsAll.ExternalTokens)
	}
	// Provider sum must equal Model sum must equal grand total
	var provSum, modelSum int64
	for _, p := range statsAll.Providers {
		provSum += p.Tokens
	}
	for _, m := range statsAll.Models {
		modelSum += m.Tokens
	}
	if provSum != statsAll.Totals.Total || modelSum != statsAll.Totals.Total {
		t.Fatalf("invariance broken: total=%d provSum=%d modelSum=%d", statsAll.Totals.Total, provSum, modelSum)
	}
	// Unified project check: both Lever Claude and External Codex ran in repoDir => 1 project!
	if len(statsAll.Projects) != 1 || statsAll.Projects[0].Name != "lever-demo" {
		t.Fatalf("expected unified lever-demo project, got %+v", statsAll.Projects)
	}
	if statsAll.Projects[0].Additions != 160 || statsAll.Projects[0].Deletions != 40 {
		t.Fatalf("project diff = +%d/-%d, want +160/-40", statsAll.Projects[0].Additions, statsAll.Projects[0].Deletions)
	}
	// Agent check
	if len(statsAll.Agents) != 1 || statsAll.Agents[0].Name != "Architect" || statsAll.Agents[0].Runs != 2 {
		t.Fatalf("unexpected agents: %+v", statsAll.Agents)
	}
	// Sessions check: Lever session runs == 2 (not 2+1 double counted!)
	if len(statsAll.Sessions) != 2 {
		t.Fatalf("sessions = %d, want 2", len(statsAll.Sessions))
	}
	if statsAll.Sessions[0].Source != "lever" || statsAll.Sessions[0].Runs != 2 || statsAll.Sessions[0].ChatID != "c1" {
		t.Fatalf("unexpected top session: %+v", statsAll.Sessions[0])
	}
	// Hourly matrix check: 7*24 = 168 cells, sum matches 18400
	if len(statsAll.Hourly) != 168 {
		t.Fatalf("hourly len = %d, want 168", len(statsAll.Hourly))
	}
	var hourSum int64
	for _, c := range statsAll.Hourly {
		hourSum += c.Tokens
	}
	if hourSum != 18400 {
		t.Fatalf("hourly sum = %d, want 18400", hourSum)
	}

	// Scope=lever must exclude external codex session
	statsLever, err := svc.Stats(context.Background(), Query{Period: "7d", Scope: "lever", TimeZone: "UTC"})
	if err != nil {
		t.Fatal(err)
	}
	if statsLever.Totals.Total != 16000 || statsLever.ExternalTokens != 0 || len(statsLever.Sessions) != 1 {
		t.Fatalf("scope=lever mismatch: total=%d ext=%d sessions=%d", statsLever.Totals.Total, statsLever.ExternalTokens, len(statsLever.Sessions))
	}

	// Summary check: today has 1 Lever run + 1 CLI call = 2; last7d has 2 Lever runs + 1 CLI call = 3
	sum, err := svc.Summary(context.Background(), "UTC")
	if err != nil {
		t.Fatal(err)
	}
	if sum.Today.Tokens != 13200 || sum.Last7d.Tokens != 18400 {
		t.Fatalf("summary tokens mismatch: today=%d 7d=%d", sum.Today.Tokens, sum.Last7d.Tokens)
	}
	if sum.Today.Runs != 2 || sum.Last7d.Runs != 3 {
		t.Fatalf("summary runs mismatch: today=%d 7d=%d", sum.Today.Runs, sum.Last7d.Runs)
	}
}

func joinLines(lines []string) string {
	out := ""
	for _, l := range lines {
		out += l + "\n"
	}
	return out
}

func pbVarint(fieldNum, val uint64) []byte {
	var buf [20]byte
	n := binary.PutUvarint(buf[:], (fieldNum<<3)|0)
	n += binary.PutUvarint(buf[n:], val)
	return append([]byte(nil), buf[:n]...)
}

func pbBytes(fieldNum uint64, payload []byte) []byte {
	var buf [20]byte
	n := binary.PutUvarint(buf[:], (fieldNum<<3)|2)
	n += binary.PutUvarint(buf[n:], uint64(len(payload)))
	out := make([]byte, 0, n+len(payload))
	out = append(out, buf[:n]...)
	out = append(out, payload...)
	return out
}

func concatPB(chunks ...[]byte) []byte {
	var out []byte
	for _, c := range chunks {
		out = append(out, c...)
	}
	return out
}
