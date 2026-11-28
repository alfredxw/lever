package app

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"regexp"
	"strings"
	"time"

	"lever/internal/model"
	"lever/internal/store"
)

// QuestionTimeoutFallbackAnswer is sent for open-ended questions (or choice prompts
// that allow custom answers without an explicitly recommended option) when the user
// does not respond before the configured timeout.
const QuestionTimeoutFallbackAnswer = "No user response before timeout. Please proceed with your recommended option."

var (
	negativeRecommendedPattern = regexp.MustCompile(`(?i)\b(?:not|non|un)\s*[-]?\s*recommended\b|不推荐|非推荐|暂不推荐`)
	positiveRecommendedPattern = regexp.MustCompile(`(?i)(?:^|[\s(\[（【—\-:：])recommended(?:$|[\s)\]）】—\-:：,.!])|(?:^|[\s(\[（【—\-:：])推荐(?:$|[\s)\]）】—\-:：，。！使选])`)
	positiveDefaultPattern     = regexp.MustCompile(`(?i)(?:^|[\s(\[（【])default(?:$|[\s)\]）】:：])|(?:^|[\s(\[（【])默认(?:$|[\s)\]）】:：])`)
)

func prepareQuestionDeadline(ctx context.Context, q store.Queryer, r *model.Request) (time.Time, bool, error) {
	if r.Kind != "question" || len(r.Questions) == 0 {
		return time.Time{}, false, nil
	}
	settings, err := questionSettings(ctx, q)
	if err != nil {
		return time.Time{}, false, err
	}
	if settings.TimeoutSeconds <= 0 {
		return time.Time{}, false, nil
	}
	deadline := time.Now().UTC().Add(time.Duration(settings.TimeoutSeconds) * time.Second)
	r.ExpiresAt = deadline.Format(time.RFC3339Nano)
	return deadline, true, nil
}

type questionTimer struct {
	timer *time.Timer
}

func (a *App) scheduleQuestionTimeout(requestID string, deadline time.Time) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.scheduleQuestionTimeoutLocked(requestID, deadline)
}

func (a *App) scheduleQuestionTimeoutLocked(requestID string, deadline time.Time) {
	if a.closed || requestID == "" {
		return
	}
	if prev := a.questionTimers[requestID]; prev != nil && prev.timer != nil {
		prev.timer.Stop()
	}
	delay := time.Until(deadline)
	if delay < 0 {
		delay = 0
	}
	entry := &questionTimer{}
	a.questionTimers[requestID] = entry
	entry.timer = time.AfterFunc(delay, func() {
		a.fireQuestionTimeout(requestID, entry)
	})
}

func (a *App) cancelQuestionTimeout(requestID string) {
	a.mu.Lock()
	a.cancelQuestionTimeoutLocked(requestID)
	a.mu.Unlock()
}

func (a *App) cancelQuestionTimeoutLocked(requestID string) {
	if entry := a.questionTimers[requestID]; entry != nil {
		if entry.timer != nil {
			entry.timer.Stop()
		}
		delete(a.questionTimers, requestID)
	}
}

func (a *App) fireQuestionTimeout(requestID string, entry *questionTimer) {
	a.mu.Lock()
	if a.closed || a.questionTimers[requestID] != entry {
		a.mu.Unlock()
		return
	}
	delete(a.questionTimers, requestID)
	a.wg.Add(1)
	a.mu.Unlock()
	defer a.wg.Done()

	if a.ctx.Err() != nil {
		return
	}
	if err := a.autoAnswerQuestion(a.ctx, requestID); err != nil {
		var appErr *Error
		if !errors.As(err, &appErr) && !errors.Is(err, sql.ErrNoRows) && !errors.Is(err, context.Canceled) {
			slog.Warn("auto-answer timed-out question", "request", requestID, "error", err)
		}
	}
}

func (a *App) autoAnswerQuestion(ctx context.Context, id string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return nil
	}
	request, err := store.Get[model.Request](ctx, a.Store.DB, "SELECT data FROM requests WHERE id=?", id)
	if err != nil {
		return err
	}
	if request.Status != "pending" || request.Kind != "question" || request.ExpiresAt == "" {
		return nil
	}
	if deadline, parseErr := time.Parse(time.RFC3339Nano, request.ExpiresAt); parseErr == nil {
		if time.Until(deadline) > 100*time.Millisecond {
			a.scheduleQuestionTimeoutLocked(id, deadline)
			return nil
		}
	}
	e := a.active[request.RunID]
	if e == nil {
		return nil
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	ch := e.requests[id]
	if e.run.Status == "cancelling" || (ch == nil && !e.hosted) {
		return nil
	}
	answer := buildRecommendedQuestionAnswer(request)
	request.Status = "answered"
	request.Answer = &answer
	request.AutoAnswered = true
	if err := a.Store.Write(ctx, func(tx *sql.Tx) error {
		return store.SaveRequest(tx, request)
	}); err != nil {
		return err
	}
	if ch != nil {
		ch <- answer
		delete(e.requests, id)
	}
	return nil
}

// CancelQuestionTimeout clears the auto-proceed deadline for a pending question so the
// user can take as long as needed to answer it manually.
func (a *App) CancelQuestionTimeout(ctx context.Context, id string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	request, err := store.Get[model.Request](ctx, a.Store.DB, "SELECT data FROM requests WHERE id=?", id)
	if err != nil {
		return err
	}
	if request.Status != "pending" || request.Kind != "question" {
		return conflict("Request is no longer pending")
	}
	a.cancelQuestionTimeoutLocked(id)
	if request.ExpiresAt == "" {
		return nil
	}
	request.ExpiresAt = ""
	return a.Store.Write(ctx, func(tx *sql.Tx) error {
		return store.SaveRequest(tx, request)
	})
}

func textMatchesRecommendation(s string) bool {
	s = strings.TrimSpace(s)
	if s == "" || negativeRecommendedPattern.MatchString(s) {
		return false
	}
	return positiveRecommendedPattern.MatchString(s)
}

func textMatchesDefault(s string) bool {
	s = strings.TrimSpace(s)
	if s == "" || negativeRecommendedPattern.MatchString(s) {
		return false
	}
	return positiveDefaultPattern.MatchString(s)
}

func recommendedOptionIDs(q model.Question) []string {
	var structured []string
	for _, opt := range q.Options {
		if opt.Recommended {
			structured = append(structured, opt.ID)
		}
	}
	if len(structured) > 0 {
		return structured
	}

	var byLabel []string
	for _, opt := range q.Options {
		if textMatchesRecommendation(opt.Label) {
			byLabel = append(byLabel, opt.ID)
		}
	}
	if len(byLabel) > 0 {
		return byLabel
	}

	var byDesc []string
	for _, opt := range q.Options {
		if textMatchesRecommendation(opt.Description) {
			byDesc = append(byDesc, opt.ID)
		}
	}
	if len(byDesc) > 0 {
		return byDesc
	}

	var byDefault []string
	for _, opt := range q.Options {
		if textMatchesDefault(opt.Label) {
			byDefault = append(byDefault, opt.ID)
		}
	}
	return byDefault
}

func isNumericQuestion(q model.Question) bool {
	return q.InputType == "number" || q.InputType == "integer"
}

func buildRecommendedQuestionAnswer(req model.Request) model.Answer {
	answers := make(map[string][]string, len(req.Questions))
	for _, q := range req.Questions {
		if q.Secret {
			if q.InitialAnswer != "" {
				answers[q.ID] = []string{q.InitialAnswer}
				continue
			}
			if !q.IsRequired() {
				continue
			}
			return model.Answer{Allow: false, Answers: map[string][]string{}}
		}

		if len(q.Options) > 0 {
			recommended := recommendedOptionIDs(q)
			if len(recommended) > 0 {
				if q.Multiple {
					answers[q.ID] = recommended
				} else {
					answers[q.ID] = []string{recommended[0]}
				}
				continue
			}
			if q.AllowsCustom() {
				if !q.IsRequired() {
					continue
				}
				answers[q.ID] = []string{QuestionTimeoutFallbackAnswer}
				continue
			}
			if !q.IsRequired() {
				if q.Multiple {
					answers[q.ID] = []string{}
				}
				continue
			}
			answers[q.ID] = []string{q.Options[0].ID}
			continue
		}

		if q.InitialAnswer != "" {
			answers[q.ID] = []string{q.InitialAnswer}
			continue
		}
		if isNumericQuestion(q) {
			if !q.IsRequired() {
				continue
			}
			return model.Answer{Allow: false, Answers: map[string][]string{}}
		}
		if !q.IsRequired() {
			continue
		}
		answers[q.ID] = []string{QuestionTimeoutFallbackAnswer}
	}

	// If a prompt consists solely of optional free-text/custom question(s) (e.g. Pi `input`
	// or an optional ACP choice+other form with no recommended option), send the recommendation
	// fallback so the agent receives a clear instruction rather than an empty payload.
	if len(answers) == 0 && len(req.Questions) == 1 {
		q := req.Questions[0]
		if !q.Secret && !isNumericQuestion(q) && q.AllowsCustom() {
			answers[q.ID] = []string{QuestionTimeoutFallbackAnswer}
		}
	}

	return model.Answer{
		Allow:   true,
		Answers: answers,
	}
}
