package provider

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"lever/internal/device"
	"lever/internal/model"
)

type piTranscript struct {
	sink                  Sink
	items                 map[string]model.Item
	assets                string
	runID                 string
	cwd                   string
	imageBudget           *turnImageBudget
	message               int
	failure               error
	contextWindow         int64
	lastUsedTokens        int64
	compacted             bool
	compactionAfterTokens int64
}

func piUsageTokens(usage object) int64 {
	if total, ok := nonNegativeInt(usage["totalTokens"]); ok && total > 0 {
		return total
	}
	var sum int64
	for _, key := range []string{"input", "cacheRead", "cacheWrite", "output"} {
		if n, ok := nonNegativeInt(usage[key]); ok {
			sum += n
		}
	}
	return sum
}

func (t *piTranscript) reportUsage(usage object) error {
	used := piUsageTokens(usage)
	if used <= 0 || used == t.lastUsedTokens {
		return nil
	}
	t.lastUsedTokens = used
	return setContextUsage(t.sink, used, t.contextWindow)
}

func (t *piTranscript) emit(item model.Item) error {
	t.items[item.ID] = item
	if item.Kind == "reasoning" && strings.TrimSpace(item.Text) == "" {
		return nil
	}
	return t.sink.Item(item)
}

func (t *piTranscript) update(frame object) error {
	message := obj(frame["message"])
	switch frame["type"] {
	case "message_start":
		if message["role"] == "assistant" {
			t.message++
		}
	case "message_update":
		if frame["usage"] != nil {
			if err := t.reportUsage(obj(frame["usage"])); err != nil {
				return err
			}
		}
		delta := obj(frame["assistantMessageEvent"])
		kind := ""
		switch delta["type"] {
		case "text_delta":
			kind = "text"
		case "thinking_delta":
			kind = "reasoning"
		default:
			return nil
		}
		index, _ := delta["contentIndex"].(float64)
		id := fmt.Sprintf("message-%d-%d", t.message, int(index))
		return t.emit(model.Item{ID: id, Kind: kind, Status: "running", Text: t.items[id].Text + str(delta["delta"])})
	case "message_end":
		if message["role"] != "assistant" {
			return nil
		}
		if message["usage"] != nil {
			if err := t.reportUsage(obj(message["usage"])); err != nil {
				return err
			}
		}
		for i, value := range arr(message["content"]) {
			content := obj(value)
			item := model.Item{ID: fmt.Sprintf("message-%d-%d", t.message, i), Status: "completed"}
			switch content["type"] {
			case "text":
				item.Kind, item.Text = "text", str(content["text"])
			case "thinking":
				item.Kind, item.Text = "reasoning", str(content["thinking"])
			default:
				continue
			}
			if err := t.emit(item); err != nil {
				return err
			}
		}
		switch message["stopReason"] {
		case "error":
			detail := str(message["errorMessage"])
			if detail == "" {
				detail = "Pi reported a model error"
			}
			t.failure = errors.New(clip(detail))
		case "aborted":
			t.failure = context.Canceled
		default:
			t.failure = nil
		}
	case "compaction_end", "auto_compaction_end":
		if frame["aborted"] == true {
			return nil
		}
		result := obj(frame["result"])
		if len(result) == 0 {
			return nil
		}
		t.compacted = true
		if after, ok := nonNegativeInt(result["estimatedTokensAfter"]); ok && after > 0 {
			t.compactionAfterTokens = after
			t.lastUsedTokens = after
			return setContextUsage(t.sink, after, t.contextWindow)
		}
		t.lastUsedTokens = 0
		return t.sink.UpdateRuntime(func(s *model.SessionRuntime) { s.Context = nil })
	case "tool_execution_start", "tool_execution_update", "tool_execution_end":
		id := "tool-" + str(frame["toolCallId"])
		item := t.items[id]
		item.ID, item.Kind, item.Status = id, "tool", "running"
		if name := str(frame["toolName"]); name != "" {
			item.Title = name
		}
		if frame["type"] == "tool_execution_start" {
			item.Text = clip(pretty(frame["args"]))
		} else {
			result := obj(frame["result"])
			if frame["type"] == "tool_execution_update" {
				result = obj(frame["partialResult"])
			} else {
				item.Status = "completed"
				if frame["isError"] == true {
					item.Status = "failed"
				}
			}
			imgs, _ := extractToolOutputImages(t.assets, t.runID, id, t.cwd, result["content"], t.imageBudget)
			for _, img := range imgs {
				item.ImageFiles = appendUniqueImageFile(item.ImageFiles, img)
			}
			var lines []string
			for _, value := range arr(result["content"]) {
				if part := obj(value); part["type"] == "text" {
					lines = append(lines, str(part["text"]))
				}
			}
			if len(lines) > 0 {
				item.Text = clip(strings.Join(lines, "\n"))
			}
		}
		return t.emit(item)
	}
	return nil
}

func answerPiDialog(ctx context.Context, p *device.Process, sink Sink, frame object) error {
	method := str(frame["method"])
	title := strings.TrimSpace(str(frame["title"]))
	request := model.Request{Kind: "question", Title: title}
	if request.Title == "" {
		request.Title = "Agent needs your input"
	}
	options := arr(frame["options"])
	var selectRaw []string
	var selectIDs []string
	switch method {
	case "select":
		questionText := title
		if questionText == "" {
			questionText = "Choose an option"
		}
		counts := map[string]int{}
		selectRaw = make([]string, len(options))
		for i, value := range options {
			s := str(value)
			selectRaw[i] = s
			counts[s]++
		}
		selectIDs = make([]string, len(selectRaw))
		qOptions := make([]model.QuestionOption, len(selectRaw))
		for i, s := range selectRaw {
			id := s
			if id == "" || counts[s] > 1 {
				id = strconv.Itoa(i)
			}
			label := s
			if strings.TrimSpace(label) == "" {
				label = "Empty value"
			}
			selectIDs[i] = id
			qOptions[i] = model.QuestionOption{ID: id, Label: label}
		}
		request.Title = "Agent needs your input"
		request.Questions = []model.Question{{
			ID:          "value",
			Header:      "Question",
			Text:        questionText,
			Options:     qOptions,
			AllowCustom: boolPtr(false),
		}}
	case "confirm":
		request.Kind, request.Detail = "approval", str(frame["message"])
	case "input", "editor":
		message := strings.TrimSpace(str(frame["message"]))
		placeholder := strings.TrimSpace(str(frame["placeholder"]))
		header := "Question"
		questionText := title
		if message != "" && title != "" && message != title {
			header = title
			questionText = message
		} else if questionText == "" {
			questionText = message
		}
		if questionText == "" {
			questionText = placeholder
		}
		if questionText == "" {
			questionText = "Provide your input"
		}
		q := model.Question{
			ID:          "value",
			Header:      header,
			Text:        questionText,
			Placeholder: placeholder,
			Required:    boolPtr(false),
			Options:     []model.QuestionOption{},
		}
		if method == "editor" {
			q.InitialAnswer = str(frame["prefill"])
		}
		request.Questions = []model.Question{q}
	default:
		return nil
	}
	lifetime, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		select {
		case <-p.Done:
			cancel()
		case <-lifetime.Done():
		}
	}()
	ask := lifetime
	if timeout, ok := frame["timeout"].(float64); ok && timeout > 0 {
		var stop context.CancelFunc
		ask, stop = context.WithTimeout(ask, time.Duration(timeout)*time.Millisecond)
		defer stop()
	}
	answer, err := sink.Ask(ask, request)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		select {
		case <-p.Done:
			return errors.Join(errors.New("Pi exited while waiting for an answer"), p.Error())
		default:
		}
		if !errors.Is(err, context.DeadlineExceeded) {
			return err
		}
	}
	response := object{"type": "extension_ui_response", "id": frame["id"]}
	switch {
	case method == "confirm" && err == nil:
		response["confirmed"] = answer.Allow
	case answer.Allow && err == nil && method == "select":
		selected := answer.OptionID
		if selected == "" {
			if values := answer.Answers["value"]; len(values) > 0 {
				selected = values[0]
			}
		}
		matched := false
		for i, id := range selectIDs {
			if id == selected {
				response["value"] = selectRaw[i]
				matched = true
				break
			}
		}
		if !matched {
			if i, convErr := strconv.Atoi(selected); convErr == nil && i >= 0 && i < len(selectRaw) {
				response["value"] = selectRaw[i]
			}
		}
	case answer.Allow && err == nil:
		if values := answer.Answers["value"]; len(values) != 0 {
			response["value"] = values[0]
		} else {
			response["value"] = ""
		}
	}
	if response["value"] == nil && response["confirmed"] == nil {
		response["cancelled"] = true
	}
	return p.Send(response)
}
