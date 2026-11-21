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
	sink    Sink
	items   map[string]model.Item
	message int
	failure error
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
	method, title := str(frame["method"]), str(frame["title"])
	request := model.Request{Kind: "question", Title: title}
	options := arr(frame["options"])
	switch method {
	case "select":
		for i, value := range options {
			request.Options = append(request.Options, model.RequestOption{ID: strconv.Itoa(i), Name: str(value), Allow: true})
		}
	case "confirm":
		request.Kind, request.Detail = "approval", str(frame["message"])
	case "input", "editor":
		detail := str(frame["placeholder"])
		if method == "editor" {
			detail = str(frame["prefill"])
		}
		if detail == "" {
			detail = title
		}
		request.Questions = []model.Question{{ID: "value", Text: detail, Options: []model.QuestionOption{}}}
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
	case answer.Allow && method == "select":
		if i, err := strconv.Atoi(answer.OptionID); err == nil && i >= 0 && i < len(options) {
			response["value"] = options[i]
		}
	case answer.Allow:
		if values := answer.Answers["value"]; len(values) != 0 {
			response["value"] = values[0]
		}
	}
	if response["value"] == nil && response["confirmed"] == nil {
		response["cancelled"] = true
	}
	return p.Send(response)
}
