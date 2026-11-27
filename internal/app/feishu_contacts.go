package app

import (
	"context"
	"database/sql"
	"log/slog"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"lever/internal/model"
	"lever/internal/plugin"
	larkbot "lever/internal/plugin/builtin/lark-bot"
)

const (
	feishuContactCacheTTL       = 3 * time.Minute
	feishuUserHydrateCooldown   = 2 * time.Minute
	feishuMaxAccessRequests     = 20
	feishuMaxSearchResults      = 50
	feishuAccessPreviewMaxRunes = 80
)

var (
	feishuFullEmailRe = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)
	feishuMobileRe    = regexp.MustCompile(`^(?:\+\d{6,15}|1\d{10})$`)
)

type feishuContactDirCache struct {
	contacts      []model.FeishuContact
	missingScopes []string
	fetchedAt     time.Time
}

type feishuAccessReqRecord struct {
	OpenID      string
	Name        string
	AvatarURL   string
	ChatID      string // Internal only: never serialized into ChannelView.
	Preview     string
	RequestedAt string
}

func normalizeFeishuMobile(raw string) string {
	s := strings.TrimSpace(raw)
	s = strings.ReplaceAll(s, " ", "")
	s = strings.ReplaceAll(s, "-", "")
	return s
}

func isFeishuMobileQuery(raw string) bool {
	return feishuMobileRe.MatchString(normalizeFeishuMobile(raw))
}

func isFeishuEmailQuery(raw string) bool {
	return feishuFullEmailRe.MatchString(strings.TrimSpace(raw))
}

func mergeFeishuContact(dst, src model.FeishuContact) model.FeishuContact {
	if dst.OpenID == "" {
		dst.OpenID = src.OpenID
	}
	if src.Name != "" && (dst.Name == "" || dst.Source == "recent" || dst.Source == "chat") {
		dst.Name = src.Name
	}
	if dst.EnName == "" {
		dst.EnName = src.EnName
	}
	if dst.Email == "" {
		dst.Email = src.Email
	}
	if dst.AvatarURL == "" {
		dst.AvatarURL = src.AvatarURL
	}
	if dst.Department == "" {
		dst.Department = src.Department
	}
	if dst.Source == "" {
		dst.Source = src.Source
	}
	return dst
}

func clipRunes(s string, max int) string {
	s = strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(s, "\r", " "), "\n", " "))
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	count := 0
	for i := range s {
		if count == max {
			return strings.TrimSpace(s[:i]) + "…"
		}
		count++
	}
	return s
}

func (a *App) clearFeishuBotCachesLocked(botID string) {
	if a.feishu.userCache != nil {
		delete(a.feishu.userCache, botID)
	}
	if a.feishu.contactCache != nil {
		delete(a.feishu.contactCache, botID)
	}
	if a.feishu.accessRequests != nil {
		delete(a.feishu.accessRequests, botID)
	}
	if a.feishu.hydrating != nil {
		delete(a.feishu.hydrating, botID)
	}
}

func (a *App) rememberFeishuUserLocked(botID string, c model.FeishuContact) {
	c.OpenID = strings.TrimSpace(c.OpenID)
	if botID == "" || c.OpenID == "" {
		return
	}
	if a.feishu.userCache == nil {
		a.feishu.userCache = make(map[string]map[string]model.FeishuContact)
	}
	m := a.feishu.userCache[botID]
	if m == nil {
		m = make(map[string]model.FeishuContact)
		a.feishu.userCache[botID] = m
	}
	if existing, ok := m[c.OpenID]; ok {
		m[c.OpenID] = mergeFeishuContact(existing, c)
	} else {
		m[c.OpenID] = c
	}
}

func (a *App) cachedFeishuUserNameLocked(botID, openID string) string {
	if a.feishu.userCache == nil {
		return ""
	}
	return strings.TrimSpace(a.feishu.userCache[botID][openID].Name)
}

func (a *App) knownUsersForBotLocked(cfg feishuBotConfig, settings model.FeishuBotSettings) []model.FeishuContact {
	cache := a.feishu.userCache[cfg.ID]
	if len(cache) == 0 {
		return nil
	}
	want := make(map[string]bool)
	if cfg.Binding.UserID != "" {
		want[cfg.Binding.UserID] = true
	}
	for _, id := range settings.Admins {
		want[id] = true
	}
	for _, id := range settings.DMWhitelist {
		want[id] = true
	}
	for _, id := range settings.Advanced.BlockedUsers {
		want[id] = true
	}
	for _, req := range a.feishu.accessRequests[cfg.ID] {
		want[req.OpenID] = true
	}
	if len(want) == 0 {
		return nil
	}
	out := make([]model.FeishuContact, 0, len(want))
	for id := range want {
		if c, ok := cache[id]; ok && (c.Name != "" || c.EnName != "" || c.Email != "" || c.AvatarURL != "") {
			out = append(out, c)
		}
	}
	if len(out) == 0 {
		return nil
	}
	slices.SortFunc(out, func(x, y model.FeishuContact) int {
		return strings.Compare(x.OpenID, y.OpenID)
	})
	return out
}

func (a *App) pendingRequestsForBotLocked(botID string) []model.FeishuAccessRequest {
	reqs := a.feishu.accessRequests[botID]
	if len(reqs) == 0 {
		return nil
	}
	cache := a.feishu.userCache[botID]
	out := make([]model.FeishuAccessRequest, 0, len(reqs))
	for _, r := range reqs {
		name := r.Name
		avatar := r.AvatarURL
		if c, ok := cache[r.OpenID]; ok {
			if c.Name != "" {
				name = c.Name
			}
			if c.AvatarURL != "" {
				avatar = c.AvatarURL
			}
		}
		out = append(out, model.FeishuAccessRequest{
			OpenID:      r.OpenID,
			Name:        name,
			AvatarURL:   avatar,
			Preview:     r.Preview,
			RequestedAt: r.RequestedAt,
		})
	}
	return out
}

func (a *App) recordFeishuAccessRequestLocked(botID string, m plugin.ChannelMessage) {
	if botID == "" || m.UserID == "" {
		return
	}
	if a.feishu.accessRequests == nil {
		a.feishu.accessRequests = make(map[string][]feishuAccessReqRecord)
	}
	preview := clipRunes(m.Text, feishuAccessPreviewMaxRunes)
	cached := a.feishu.userCache[botID][m.UserID]
	rec := feishuAccessReqRecord{
		OpenID:      m.UserID,
		Name:        cached.Name,
		AvatarURL:   cached.AvatarURL,
		ChatID:      m.ChatID,
		Preview:     preview,
		RequestedAt: now(),
	}
	existing := a.feishu.accessRequests[botID]
	filtered := make([]feishuAccessReqRecord, 0, min(len(existing)+1, feishuMaxAccessRequests))
	filtered = append(filtered, rec)
	for _, item := range existing {
		if item.OpenID == m.UserID {
			continue
		}
		if len(filtered) >= feishuMaxAccessRequests {
			break
		}
		filtered = append(filtered, item)
	}
	a.feishu.accessRequests[botID] = filtered
}

func (a *App) pruneFeishuAccessRequestsLocked(botID string, removeIDs ...string) {
	if a.feishu.accessRequests == nil || len(removeIDs) == 0 {
		return
	}
	reqs := a.feishu.accessRequests[botID]
	if len(reqs) == 0 {
		return
	}
	next := make([]feishuAccessReqRecord, 0, len(reqs))
	for _, r := range reqs {
		if slices.Contains(removeIDs, r.OpenID) {
			continue
		}
		next = append(next, r)
	}
	if len(next) == 0 {
		delete(a.feishu.accessRequests, botID)
	} else {
		a.feishu.accessRequests[botID] = next
	}
}

// scheduleFeishuUserHydrationLocked asynchronously fetches Feishu contact profiles
// (name, avatar, email) for open_ids not yet hydrated, optionally backfilling
// cfg.Binding.Name if updateBindingName is true.
func (a *App) scheduleFeishuUserHydrationLocked(r *channelRuntime, openIDs []string, updateBindingName bool) {
	if a.closed || r == nil || r.bot == nil || len(openIDs) == 0 {
		return
	}
	if a.feishu.hydrating == nil {
		a.feishu.hydrating = make(map[string]map[string]time.Time)
	}
	seen := a.feishu.hydrating[r.botID]
	if seen == nil {
		seen = make(map[string]time.Time)
		a.feishu.hydrating[r.botID] = seen
	}
	cache := a.feishu.userCache[r.botID]
	nowTime := time.Now()
	todo := make([]string, 0, len(openIDs))
	for _, id := range openIDs {
		id = strings.TrimSpace(id)
		if id == "" || !strings.HasPrefix(id, "ou_") {
			continue
		}
		if c, ok := cache[id]; ok && c.Name != "" && c.AvatarURL != "" {
			continue
		}
		if last, ok := seen[id]; ok && nowTime.Sub(last) < feishuUserHydrateCooldown {
			continue
		}
		seen[id] = nowTime
		todo = append(todo, id)
	}
	if len(todo) == 0 {
		return
	}
	botClient := r.bot
	botID := r.botID
	a.wg.Add(1)
	go func() {
		defer a.wg.Done()
		for _, openID := range todo {
			if r.ctx.Err() != nil {
				return
			}
			callCtx, cancel := context.WithTimeout(r.ctx, 5*time.Second)
			contact, err := botClient.GetUser(callCtx, openID, "open_id")
			cancel()
			if err != nil {
				if larkbot.IsScopeError(err) {
					return // Avoid spamming contact API when scope is absent.
				}
				continue
			}
			if contact.Name == "" && contact.AvatarURL == "" && contact.Email == "" {
				continue
			}
			a.mu.Lock()
			if a.closed || a.feishu.runtimes[botID] != r {
				a.mu.Unlock()
				return
			}
			a.rememberFeishuUserLocked(botID, contact)
			var botsToSave []feishuBotConfig
			if contact.Name != "" {
				if idx, existing := a.findFeishuBotLocked(botID); idx >= 0 &&
					existing.Binding.ID != "" &&
					existing.Binding.UserID == openID &&
					(existing.Binding.Name == "" || existing.Binding.Name == "DM") {
					updated := *existing
					updated.Binding.Name = contact.Name
					botsToSave = append([]feishuBotConfig(nil), a.feishu.bots...)
					botsToSave[idx] = updated
					a.feishu.bots = botsToSave
				}
			}
			a.mu.Unlock()
			if botsToSave != nil {
				wctx, wcancel := context.WithTimeout(a.ctx, 5*time.Second)
				_ = a.Store.Write(wctx, func(tx *sql.Tx) error { return saveFeishuBots(wctx, tx, botsToSave) })
				wcancel()
			}
		}
	}()
}

func collectBotUserIDs(cfg feishuBotConfig) []string {
	ids := make([]string, 0, len(cfg.Settings.Admins)+len(cfg.Settings.DMWhitelist)+len(cfg.Settings.Advanced.BlockedUsers)+1)
	if cfg.Binding.UserID != "" {
		ids = append(ids, cfg.Binding.UserID)
	}
	ids = append(ids, cfg.Settings.Admins...)
	ids = append(ids, cfg.Settings.DMWhitelist...)
	ids = append(ids, cfg.Settings.Advanced.BlockedUsers...)
	return ids
}

// SearchFeishuBotContacts searches contacts in this bot's app scope by name,
// email, phone number, union_id (on_...), or open_id (ou_...).
func (a *App) SearchFeishuBotContacts(ctx context.Context, botID, query string, refresh bool) (model.FeishuContactSearchResult, error) {
	q := strings.TrimSpace(query)

	a.mu.Lock()
	idx, existing := a.findFeishuBotLocked(botID)
	rt := a.feishu.runtimes[botID]
	if a.closed || idx < 0 {
		a.mu.Unlock()
		return model.FeishuContactSearchResult{}, notFound("Bot not found")
	}
	var botClient *larkbot.Bot
	var rtCtx context.Context
	if rt != nil && rt.bot != nil {
		botClient = rt.bot
		rtCtx = rt.ctx
	}
	cachedDir, hasDirCache := a.feishu.contactCache[botID]
	useDirCache := hasDirCache && !refresh && time.Since(cachedDir.fetchedAt) < feishuContactCacheTTL
	// Snapshot observed / cached users and pending requesters.
	observed := make(map[string]model.FeishuContact, len(a.feishu.userCache[botID]))
	for id, c := range a.feishu.userCache[botID] {
		observed[id] = c
	}
	pendingSet := make(map[string]bool)
	for _, req := range a.feishu.accessRequests[botID] {
		pendingSet[req.OpenID] = true
		c := observed[req.OpenID]
		c.OpenID = req.OpenID
		if c.Name == "" {
			c.Name = req.Name
		}
		if c.AvatarURL == "" {
			c.AvatarURL = req.AvatarURL
		}
		if c.Source == "" {
			c.Source = "recent"
		}
		observed[req.OpenID] = c
	}
	if existing.Binding.UserID != "" {
		c := observed[existing.Binding.UserID]
		c.OpenID = existing.Binding.UserID
		if c.Name == "" && existing.Binding.Name != "" && existing.Binding.Name != "DM" {
			c.Name = existing.Binding.Name
		}
		if c.Source == "" {
			c.Source = "recent"
		}
		observed[existing.Binding.UserID] = c
	}
	a.mu.Unlock()

	merged := make(map[string]model.FeishuContact, len(observed)+32)
	addMerged := func(c model.FeishuContact) {
		c.OpenID = strings.TrimSpace(c.OpenID)
		if c.OpenID == "" {
			return
		}
		if cur, ok := merged[c.OpenID]; ok {
			merged[c.OpenID] = mergeFeishuContact(cur, c)
		} else {
			merged[c.OpenID] = c
		}
	}
	for _, c := range observed {
		addMerged(c)
	}

	missingSet := make(map[string]bool)
	addMissing := func(scopes ...string) {
		for _, s := range scopes {
			if s != "" {
				missingSet[s] = true
			}
		}
	}
	warning := ""
	directResolved := make(map[string]bool)

	if botClient != nil {
		callCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		stop := context.AfterFunc(rtCtx, cancel)
		defer stop()

		// 1. Directory + joined-chat members (cached for 3m unless refresh=true).
		var dirContacts []model.FeishuContact
		var dirMissing []string
		if useDirCache {
			dirContacts = cachedDir.contacts
			dirMissing = cachedDir.missingScopes
		} else {
			var wg sync.WaitGroup
			var orgUsers, chatMembers []model.FeishuContact
			var orgMissing, chatMissing []string
			wg.Add(2)
			go func() {
				defer wg.Done()
				users, missing, err := botClient.ListDirectoryUsers(callCtx, 200)
				if err != nil {
					slog.Debug("Feishu directory user list failed", "bot", botID, "error", err)
					return
				}
				orgUsers = users
				orgMissing = missing
			}()
			go func() {
				defer wg.Done()
				members, missing, err := botClient.ListAllChatMembers(callCtx, 10, 200)
				if err != nil {
					slog.Debug("Feishu chat member list failed", "bot", botID, "error", err)
					return
				}
				chatMembers = members
				chatMissing = missing
			}()
			wg.Wait()

			cacheMap := make(map[string]model.FeishuContact, len(orgUsers)+len(chatMembers))
			for _, u := range orgUsers {
				if u.OpenID != "" {
					cacheMap[u.OpenID] = u
				}
			}
			for _, m := range chatMembers {
				if m.OpenID == "" {
					continue
				}
				if cur, ok := cacheMap[m.OpenID]; ok {
					cacheMap[m.OpenID] = mergeFeishuContact(cur, m)
				} else {
					cacheMap[m.OpenID] = m
				}
			}
			dirContacts = make([]model.FeishuContact, 0, len(cacheMap))
			for _, c := range cacheMap {
				dirContacts = append(dirContacts, c)
			}
			dirMissing = append(dirMissing, orgMissing...)
			dirMissing = append(dirMissing, chatMissing...)

			if callCtx.Err() == nil {
				a.mu.Lock()
				if a.feishu.contactCache == nil {
					a.feishu.contactCache = make(map[string]feishuContactDirCache)
				}
				a.feishu.contactCache[botID] = feishuContactDirCache{
					contacts:      dirContacts,
					missingScopes: dirMissing,
					fetchedAt:     time.Now(),
				}
				for _, c := range dirContacts {
					a.rememberFeishuUserLocked(botID, c)
				}
				a.mu.Unlock()
			}
		}
		for _, c := range dirContacts {
			addMerged(c)
		}
		addMissing(dirMissing...)

		// 2. Direct exact identity resolution for open_id / union_id / email / mobile.
		switch {
		case strings.HasPrefix(q, "ou_"):
			c, err := botClient.GetUser(callCtx, q, "open_id")
			if err != nil {
				if larkbot.IsCrossAppOpenIDError(err) {
					warning = "cross_app_open_id"
				} else if larkbot.IsScopeError(err) {
					addMissing("contact:user.base:readonly")
				}
			} else if c.OpenID != "" {
				c.Source = "lookup"
				directResolved[c.OpenID] = true
				addMerged(c)
			}
		case strings.HasPrefix(q, "on_"):
			c, err := botClient.GetUser(callCtx, q, "union_id")
			if err != nil {
				if larkbot.IsScopeError(err) {
					addMissing("contact:user.base:readonly")
				}
			} else if c.OpenID != "" {
				c.Source = "lookup"
				directResolved[c.OpenID] = true
				addMerged(c)
			}
		case isFeishuEmailQuery(q):
			ids, err := botClient.ResolveUsersByContact(callCtx, []string{q}, nil)
			if err != nil {
				if larkbot.IsScopeError(err) {
					addMissing("contact:user.id:readonly")
				}
			} else {
				for _, oid := range ids {
					directResolved[oid] = true
					c, gerr := botClient.GetUser(callCtx, oid, "open_id")
					if gerr != nil {
						if larkbot.IsScopeError(gerr) {
							addMissing("contact:user.base:readonly")
						}
						c = model.FeishuContact{OpenID: oid, Email: q, Source: "lookup"}
					} else {
						if c.Email == "" {
							c.Email = q
						}
						c.Source = "lookup"
					}
					addMerged(c)
				}
			}
		case isFeishuMobileQuery(q):
			norm := normalizeFeishuMobile(q)
			ids, err := botClient.ResolveUsersByContact(callCtx, nil, []string{norm})
			if err != nil {
				if larkbot.IsScopeError(err) {
					addMissing("contact:user.id:readonly")
				}
			} else {
				for _, oid := range ids {
					directResolved[oid] = true
					c, gerr := botClient.GetUser(callCtx, oid, "open_id")
					if gerr != nil {
						if larkbot.IsScopeError(gerr) {
							addMissing("contact:user.base:readonly")
						}
						c = model.FeishuContact{OpenID: oid, Source: "lookup"}
					} else {
						c.Source = "lookup"
					}
					addMerged(c)
				}
			}
		}

		// Persist any newly resolved profiles into userCache for immediate chip labels.
		if len(directResolved) > 0 {
			a.mu.Lock()
			for oid := range directResolved {
				if c, ok := merged[oid]; ok {
					a.rememberFeishuUserLocked(botID, c)
				}
			}
			a.mu.Unlock()
		}
	}

	// 3. Filter and rank results.
	needle := strings.ToLower(q)
	results := make([]model.FeishuContact, 0, len(merged))
	for _, c := range merged {
		if warning == "cross_app_open_id" && c.OpenID == q {
			continue
		}
		if needle != "" && !directResolved[c.OpenID] {
			if !strings.Contains(strings.ToLower(c.Name), needle) &&
				!strings.Contains(strings.ToLower(c.EnName), needle) &&
				!strings.Contains(strings.ToLower(c.Email), needle) &&
				!strings.Contains(strings.ToLower(c.Department), needle) &&
				!strings.Contains(strings.ToLower(c.OpenID), needle) {
				continue
			}
		}
		results = append(results, c)
	}

	rank := func(c model.FeishuContact) int {
		if directResolved[c.OpenID] {
			return 0
		}
		if needle != "" {
			if strings.EqualFold(c.Name, q) || strings.EqualFold(c.Email, q) || strings.EqualFold(c.OpenID, q) {
				return 1
			}
			if strings.HasPrefix(strings.ToLower(c.Name), needle) || strings.HasPrefix(strings.ToLower(c.EnName), needle) {
				return 2
			}
		}
		if pendingSet[c.OpenID] {
			return 3
		}
		switch c.Source {
		case "recent", "contact":
			return 4
		case "directory":
			return 5
		default:
			return 6
		}
	}
	slices.SortFunc(results, func(x, y model.FeishuContact) int {
		if rx, ry := rank(x), rank(y); rx != ry {
			return rx - ry
		}
		nx := strings.ToLower(x.Name)
		ny := strings.ToLower(y.Name)
		if nx == "" {
			nx = x.OpenID
		}
		if ny == "" {
			ny = y.OpenID
		}
		if cmp := strings.Compare(nx, ny); cmp != 0 {
			return cmp
		}
		return strings.Compare(x.OpenID, y.OpenID)
	})
	if len(results) > feishuMaxSearchResults {
		results = results[:feishuMaxSearchResults]
	}

	missingScopes := make([]string, 0, len(missingSet))
	for s := range missingSet {
		missingScopes = append(missingScopes, s)
	}
	slices.Sort(missingScopes)

	return model.FeishuContactSearchResult{
		Contacts:      results,
		MissingScopes: missingScopes,
		Warning:       warning,
	}, nil
}

// ResolveFeishuAccessRequest approves, grants admin, blocks, or dismisses a
// user's DM access directly from Lever UI (works both for pending inbound
// requests and direct authorization).
func (a *App) ResolveFeishuAccessRequest(ctx context.Context, botID string, input model.FeishuAccessRequestInput) (model.ChannelView, error) {
	openID := strings.TrimSpace(input.OpenID)
	action := strings.TrimSpace(input.Action)
	if openID == "" || len(openID) > 128 || strings.ContainsAny(openID, "\x00\r\n \t") {
		return model.ChannelView{}, invalid("Invalid Feishu Open ID")
	}
	switch action {
	case "allow_dm", "grant_admin", "block", "dismiss":
	default:
		return model.ChannelView{}, invalid("Invalid access request action")
	}

	a.mu.Lock()
	if a.closed || !a.feishu.enabled {
		a.mu.Unlock()
		return model.ChannelView{}, conflict("Enable the Feishu plugin first")
	}
	idx, existing := a.findFeishuBotLocked(botID)
	if idx < 0 {
		a.mu.Unlock()
		return model.ChannelView{}, notFound("Bot not found")
	}

	// Capture any stored chatID for optional confirmation notice before pruning.
	notifyChatID := ""
	for _, req := range a.feishu.accessRequests[botID] {
		if req.OpenID == openID {
			notifyChatID = req.ChatID
			break
		}
	}

	if input.Name != "" || input.AvatarURL != "" || input.Email != "" {
		a.rememberFeishuUserLocked(botID, model.FeishuContact{
			OpenID:    openID,
			Name:      strings.TrimSpace(input.Name),
			AvatarURL: strings.TrimSpace(input.AvatarURL),
			Email:     strings.TrimSpace(input.Email),
			Source:    "contact",
		})
	}

	if action == "dismiss" {
		a.pruneFeishuAccessRequestsLocked(botID, openID)
		view := a.feishuViewLocked()
		a.mu.Unlock()
		return view, nil
	}

	updated := *existing
	s := updated.Settings
	normalizeFeishuSettings(&s)
	switch action {
	case "grant_admin":
		if !slices.Contains(s.Admins, openID) {
			s.Admins = append(s.Admins, openID)
		}
		s.Advanced.BlockedUsers = slices.DeleteFunc(s.Advanced.BlockedUsers, func(x string) bool { return x == openID })
	case "allow_dm":
		if !slices.Contains(s.DMWhitelist, openID) {
			s.DMWhitelist = append(s.DMWhitelist, openID)
		}
		if s.DMAccess == "admin" {
			s.DMAccess = "whitelist"
		}
		s.Advanced.BlockedUsers = slices.DeleteFunc(s.Advanced.BlockedUsers, func(x string) bool { return x == openID })
	case "block":
		if !slices.Contains(s.Advanced.BlockedUsers, openID) {
			s.Advanced.BlockedUsers = append(s.Advanced.BlockedUsers, openID)
		}
		s.Admins = slices.DeleteFunc(s.Admins, func(x string) bool { return x == openID })
		s.DMWhitelist = slices.DeleteFunc(s.DMWhitelist, func(x string) bool { return x == openID })
	}
	normalizeFeishuSettings(&s)
	if err := validateFeishuSettings(s); err != nil {
		a.mu.Unlock()
		return model.ChannelView{}, err
	}
	updated.Settings = s

	bots := append([]feishuBotConfig(nil), a.feishu.bots...)
	bots[idx] = updated
	if err := a.Store.Write(ctx, func(tx *sql.Tx) error { return saveFeishuBots(ctx, tx, bots) }); err != nil {
		a.mu.Unlock()
		return model.ChannelView{}, err
	}
	a.feishu.bots = bots
	a.pruneFeishuAccessRequestsLocked(botID, openID)
	rt := a.feishu.runtimes[botID]
	a.scheduleFeishuUserHydrationLocked(rt, []string{openID}, false)
	view := a.feishuViewLocked()
	a.mu.Unlock()

	// Send a friendly best-effort confirmation DM when granting access.
	if (action == "allow_dm" || action == "grant_admin") && rt != nil && rt.bot != nil {
		var noticeText string
		if action == "grant_admin" {
			noticeText = "管理员已将你设为机器人管理员，现在可以直接发消息对话。\nYou have been granted admin access to this bot. You can send messages now."
		} else {
			noticeText = "管理员已为你开通私聊权限，现在可以直接发消息对话。\nAn admin has granted you DM access to this bot. You can send messages now."
		}
		botClient := rt.bot
		a.wg.Add(1)
		go func() {
			defer a.wg.Done()
			sendCtx, cancel := context.WithTimeout(rt.ctx, 10*time.Second)
			defer cancel()
			opts := plugin.ChannelSendOptions{
				DeliveryID: ID(),
				Text:       noticeText,
			}
			if notifyChatID != "" {
				opts.ChatID = notifyChatID
			} else {
				opts.OpenID = openID
			}
			if err := botClient.Deliver(sendCtx, opts); err != nil {
				slog.Debug("Feishu grant confirmation DM failed", "bot", botID, "error", err)
			}
		}()
	}

	return view, nil
}
