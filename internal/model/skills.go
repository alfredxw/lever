package model

import (
	"slices"
	"strings"
)

func SkillDisabled(names []string, name string) bool {
	short := name[strings.LastIndex(name, ":")+1:]
	return slices.ContainsFunc(names, func(disabled string) bool {
		return strings.EqualFold(name, disabled) || strings.EqualFold(short, disabled)
	})
}
