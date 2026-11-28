package provider

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"slices"
	"strconv"
	"strings"

	"lever/internal/model"
)

type elicitationFieldKind string

const (
	elicitationFieldText        elicitationFieldKind = "text"
	elicitationFieldNumber      elicitationFieldKind = "number"
	elicitationFieldBoolean     elicitationFieldKind = "boolean"
	elicitationFieldChoice      elicitationFieldKind = "choice"
	elicitationFieldMultiChoice elicitationFieldKind = "multiChoice"
)

type elicitationField struct {
	kind     elicitationFieldKind
	integer  bool
	values   map[string]bool
	minItems int
	maxItems int // -1 means unbounded
}

type elicitationOptions struct {
	allowOther                bool
	antigravityTitleAsQuestion bool
}

type elicitationForm struct {
	title      string
	questions  []model.Question
	empty      bool
	order      []string
	fields     map[string]elicitationField
	required   map[string]bool
	companions map[string]string
	folded     map[string]bool
	allowOther bool
}

type orderedSchemaProperty struct {
	id       string
	property object
}

func boolPtr(v bool) *bool { return &v }

func trimmedText(v any) (string, bool) {
	s, ok := v.(string)
	if !ok {
		return "", false
	}
	s = strings.TrimSpace(s)
	return s, s != ""
}

func orderedJSONProperties(raw json.RawMessage) ([]orderedSchemaProperty, bool) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return nil, true
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	tok, err := dec.Token()
	if err != nil {
		return nil, false
	}
	delim, ok := tok.(json.Delim)
	if !ok || delim != '{' {
		return nil, false
	}
	var out []orderedSchemaProperty
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return nil, false
		}
		key, ok := keyTok.(string)
		if !ok {
			return nil, false
		}
		var valRaw json.RawMessage
		if err := dec.Decode(&valRaw); err != nil {
			return nil, false
		}
		var prop object
		if err := json.Unmarshal(valRaw, &prop); err != nil || prop == nil {
			return nil, false
		}
		out = append(out, orderedSchemaProperty{id: key, property: prop})
	}
	if _, err := dec.Token(); err != nil && err != io.EOF {
		return nil, false
	}
	return out, true
}

func elicitationEnumOptions(rawValues any, rawNames any) ([]model.QuestionOption, bool) {
	entries, ok := rawValues.([]any)
	if !ok || len(entries) == 0 {
		return nil, false
	}
	values := make([]string, len(entries))
	for i, entry := range entries {
		s, ok := entry.(string)
		if !ok {
			return nil, false
		}
		values[i] = s
	}
	var names []string
	if rawNamesArr, ok := rawNames.([]any); ok && len(rawNamesArr) == len(values) {
		names = make([]string, len(values))
		for i, entry := range rawNamesArr {
			names[i] = strings.TrimSpace(str(entry))
		}
	}

	counts := map[string]int{}
	for _, value := range values {
		counts[strings.TrimSpace(value)]++
	}
	options := make([]model.QuestionOption, len(values))
	seenLabels := map[string]bool{}
	collision := false
	for i, value := range values {
		label := ""
		if i < len(names) && names[i] != "" {
			label = names[i]
		} else {
			plain := strings.TrimSpace(value)
			if plain != "" && counts[plain] == 1 {
				label = plain
			} else {
				label = strconv.Quote(value)
			}
		}
		if seenLabels[label] {
			collision = true
		}
		seenLabels[label] = true
		options[i] = model.QuestionOption{ID: value, Label: label}
	}
	if collision {
		for i := range options {
			options[i].Label = strconv.Quote(options[i].ID)
		}
	}
	return options, true
}

func elicitationTitledOptions(rawEntries any) ([]model.QuestionOption, bool) {
	entries, ok := rawEntries.([]any)
	if !ok || len(entries) == 0 {
		return nil, false
	}
	options := make([]model.QuestionOption, 0, len(entries))
	for _, raw := range entries {
		entry := obj(raw)
		if entry == nil {
			return nil, false
		}
		value, ok := entry["const"].(string)
		if !ok {
			return nil, false
		}
		label, hasTitle := trimmedText(entry["title"])
		if !hasTitle {
			label, hasTitle = trimmedText(value)
		}
		if !hasTitle {
			return nil, false
		}
		desc, _ := trimmedText(entry["description"])
		options = append(options, model.QuestionOption{
			ID:          value,
			Label:       label,
			Description: desc,
		})
	}
	return options, true
}

func parseElicitationField(property object) (elicitationField, []model.QuestionOption, bool) {
	switch str(property["type"]) {
	case "string":
		hasEnum := property["enum"] != nil
		hasOneOf := property["oneOf"] != nil
		if !hasEnum && !hasOneOf {
			return elicitationField{kind: elicitationFieldText}, []model.QuestionOption{}, true
		}
		var (
			options []model.QuestionOption
			ok      bool
		)
		if hasOneOf {
			options, ok = elicitationTitledOptions(property["oneOf"])
		} else {
			options, ok = elicitationEnumOptions(property["enum"], property["enumNames"])
		}
		if !ok {
			return elicitationField{}, nil, false
		}
		values := make(map[string]bool, len(options))
		for _, opt := range options {
			values[opt.ID] = true
		}
		return elicitationField{kind: elicitationFieldChoice, values: values}, options, true

	case "array":
		items := obj(property["items"])
		if items == nil {
			return elicitationField{}, nil, false
		}
		var (
			options []model.QuestionOption
			ok      bool
		)
		if str(items["type"]) == "string" {
			options, ok = elicitationEnumOptions(items["enum"], items["enumNames"])
		} else if items["type"] == nil && items["anyOf"] != nil {
			options, ok = elicitationTitledOptions(items["anyOf"])
		}
		if !ok {
			return elicitationField{}, nil, false
		}
		values := make(map[string]bool, len(options))
		for _, opt := range options {
			values[opt.ID] = true
		}
		minItems := 0
		if rawMin, ok := nonNegativeInt(property["minItems"]); ok {
			minItems = int(rawMin)
		} else if property["minItems"] != nil {
			return elicitationField{}, nil, false
		}
		maxItems := -1
		if rawMax, ok := nonNegativeInt(property["maxItems"]); ok {
			maxItems = int(rawMax)
		} else if property["maxItems"] != nil {
			return elicitationField{}, nil, false
		}
		if maxItems == 0 || (maxItems >= 0 && minItems > maxItems) || minItems > len(values) {
			return elicitationField{}, nil, false
		}
		return elicitationField{
			kind:     elicitationFieldMultiChoice,
			values:   values,
			minItems: minItems,
			maxItems: maxItems,
		}, options, true

	case "boolean":
		return elicitationField{kind: elicitationFieldBoolean}, []model.QuestionOption{
			{ID: "true", Label: "Yes"},
			{ID: "false", Label: "No"},
		}, true

	case "number", "integer":
		return elicitationField{
			kind:    elicitationFieldNumber,
			integer: str(property["type"]) == "integer",
		}, []model.QuestionOption{}, true

	default:
		return elicitationField{}, nil, false
	}
}

func elicitationDefaultAnswer(property object, kind elicitationFieldKind) string {
	raw, ok := property["default"]
	if !ok || raw == nil {
		return ""
	}
	switch kind {
	case elicitationFieldText:
		return str(raw)
	case elicitationFieldNumber:
		switch v := raw.(type) {
		case float64:
			if !math.IsNaN(v) && !math.IsInf(v, 0) {
				return strconv.FormatFloat(v, 'f', -1, 64)
			}
		case string:
			return strings.TrimSpace(v)
		}
	}
	return ""
}

func parseElicitationForm(rawSchema json.RawMessage, message string, opts elicitationOptions) (*elicitationForm, bool) {
	var envelope struct {
		Type        string          `json:"type"`
		Title       string          `json:"title"`
		Description string          `json:"description"`
		Properties  json.RawMessage `json:"properties"`
		Required    []string        `json:"required"`
	}
	if err := json.Unmarshal(rawSchema, &envelope); err != nil {
		return nil, false
	}
	if envelope.Type != "" && envelope.Type != "object" {
		return nil, false
	}
	ordered, ok := orderedJSONProperties(envelope.Properties)
	if !ok {
		return nil, false
	}
	required := map[string]bool{}
	for _, key := range envelope.Required {
		required[key] = true
	}

	form := &elicitationForm{
		title:      strings.TrimSpace(envelope.Title),
		empty:      len(ordered) == 0,
		fields:     make(map[string]elicitationField, len(ordered)),
		required:   required,
		companions: map[string]string{},
		folded:     map[string]bool{},
		allowOther: opts.allowOther,
	}
	if len(ordered) == 0 {
		form.questions = []model.Question{}
		return form, true
	}

	type parsedProp struct {
		id       string
		property object
		options  []model.QuestionOption
	}
	parsed := make([]parsedProp, 0, len(ordered))
	for _, entry := range ordered {
		trimmed, nonEmpty := trimmedText(entry.id)
		if !nonEmpty || trimmed != entry.id {
			return nil, false
		}
		field, options, ok := parseElicitationField(entry.property)
		if !ok {
			return nil, false
		}
		form.order = append(form.order, entry.id)
		form.fields[entry.id] = field
		parsed = append(parsed, parsedProp{id: entry.id, property: entry.property, options: options})
	}

	// Fold optional `<id>__other` or `<id>_other` text fields into their optional single-choice field.
	for _, id := range form.order {
		field := form.fields[id]
		if field.kind != elicitationFieldChoice || required[id] {
			continue
		}
		for _, candidate := range []string{id + "__other", id + "_other"} {
			if companion, exists := form.fields[candidate]; exists && companion.kind == elicitationFieldText && !required[candidate] {
				form.companions[id] = candidate
				form.folded[candidate] = true
				break
			}
		}
	}

	fallbackMessage := strings.TrimSpace(message)
	if fallbackMessage == "" {
		fallbackMessage = strings.TrimSpace(envelope.Description)
	}
	if fallbackMessage == "" {
		fallbackMessage = "Provide your input"
	}

	form.questions = make([]model.Question, 0, len(parsed))
	for _, entry := range parsed {
		if form.folded[entry.id] {
			continue
		}
		field := form.fields[entry.id]
		index := len(form.questions) + 1
		propTitle, hasTitle := trimmedText(entry.property["title"])
		propDesc, hasDesc := trimmedText(entry.property["description"])

		header := propTitle
		text := propDesc
		if opts.antigravityTitleAsQuestion && hasTitle && !hasDesc {
			header = fmt.Sprintf("Question %d", index)
			text = propTitle
		} else {
			if header == "" {
				header = fmt.Sprintf("Question %d", index)
			}
			if text == "" {
				text = fallbackMessage
			}
		}

		q := model.Question{
			ID:            entry.id,
			Header:        header,
			Text:          text,
			Options:       entry.options,
			Multiple:      field.kind == elicitationFieldMultiChoice,
			InitialAnswer: elicitationDefaultAnswer(entry.property, field.kind),
		}
		allowCustom := field.kind == elicitationFieldText ||
			field.kind == elicitationFieldNumber ||
			form.companions[entry.id] != "" ||
			(opts.allowOther && field.kind == elicitationFieldChoice)
		if !allowCustom {
			q.AllowCustom = boolPtr(false)
		}
		if field.kind == elicitationFieldMultiChoice {
			req := field.minItems > 0 && required[entry.id]
			q.Required = boolPtr(req)
		} else if !required[entry.id] {
			q.Required = boolPtr(false)
		}
		if field.kind == elicitationFieldNumber {
			if field.integer {
				q.Placeholder = "Enter an integer"
			} else {
				q.Placeholder = "Enter a number"
			}
		}
		form.questions = append(form.questions, q)
	}
	return form, true
}

func (f *elicitationForm) content(answers map[string][]string) (map[string]any, bool) {
	result := map[string]any{}
	for _, id := range f.order {
		if f.folded[id] {
			continue
		}
		field := f.fields[id]
		values, present := answers[id]
		companionID := f.companions[id]

		switch field.kind {
		case elicitationFieldText:
			if present && len(values) > 0 {
				result[id] = values[0]
			} else if f.required[id] {
				return nil, false
			}

		case elicitationFieldNumber:
			raw := ""
			if present && len(values) > 0 {
				raw = strings.TrimSpace(values[0])
			}
			if raw == "" {
				if f.required[id] {
					return nil, false
				}
				continue
			}
			parsed, err := strconv.ParseFloat(raw, 64)
			if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
				if f.required[id] {
					return nil, false
				}
				continue
			}
			if field.integer {
				if math.Trunc(parsed) != parsed {
					if f.required[id] {
						return nil, false
					}
					continue
				}
				if i, err := strconv.ParseInt(raw, 10, 64); err == nil {
					result[id] = i
				} else {
					result[id] = int64(parsed)
				}
			} else {
				result[id] = parsed
			}

		case elicitationFieldBoolean:
			if !present || len(values) == 0 {
				if f.required[id] {
					return nil, false
				}
				continue
			}
			switch strings.ToLower(strings.TrimSpace(values[0])) {
			case "true":
				result[id] = true
			case "false":
				result[id] = false
			default:
				if f.required[id] {
					return nil, false
				}
			}

		case elicitationFieldChoice:
			if !present || len(values) == 0 {
				if f.required[id] {
					return nil, false
				}
				continue
			}
			val := values[0]
			if field.values[val] {
				result[id] = val
			} else if f.allowOther && strings.TrimSpace(val) != "" {
				result[id] = val
			} else if companionID != "" {
				result[companionID] = val
			} else if f.required[id] {
				return nil, false
			}

		case elicitationFieldMultiChoice:
			if !present {
				if f.required[id] {
					if field.minItems == 0 {
						result[id] = []string{}
						continue
					}
					return nil, false
				}
				continue
			}
			selected := make([]string, 0, len(values))
			for _, v := range values {
				if field.values[v] && !slices.Contains(selected, v) {
					selected = append(selected, v)
				}
			}
			if len(selected) == 0 && len(values) > 0 {
				return nil, false
			}
			if len(selected) < field.minItems || (field.maxItems >= 0 && len(selected) > field.maxItems) {
				if f.required[id] {
					return nil, false
				}
				continue
			}
			result[id] = selected
		}
	}
	return result, true
}
