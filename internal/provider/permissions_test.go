package provider

import (
	"testing"

	"lever/internal/model"
)

func TestDefaultPermissionForModeAcrossProviders(t *testing.T) {
	cases := []struct {
		name     string
		provider model.Provider
		wantAuto string
		wantYOLO string
	}{
		{"codex", model.Provider{ID: "codex", Type: "codex"}, "auto_review", "full_access"},
		{"claude", model.Provider{ID: "claude", Type: "claude"}, "auto", "full_access"},
		{"pi", model.Provider{ID: "pi", Type: "pi"}, "accept_edits", "full_access"},
		{"antigravity-cli", model.Provider{ID: "antigravity", Type: "antigravity", Command: "agy"}, "auto", "turbo"},
		{"antigravity-managed", model.Provider{ID: "agy-managed", Type: "antigravity"}, "", ""},
		{"acp", model.Provider{ID: "custom", Type: "acp"}, "", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := DefaultPermissionForMode(tc.provider, model.DefaultPermissionAuto); got != tc.wantAuto {
				t.Fatalf("Auto default = %q, want %q", got, tc.wantAuto)
			}
			if got := DefaultPermissionForMode(tc.provider, model.DefaultPermissionYOLO); got != tc.wantYOLO {
				t.Fatalf("YOLO default = %q, want %q", got, tc.wantYOLO)
			}
		})
	}
}

func TestDefaultPermissionForCatalog(t *testing.T) {
	agyCLI := model.Catalog{
		DefaultPermission: "default",
		Permissions: []model.PermissionInfo{
			{ID: "request-review", Mode: "request_review"},
			{ID: "default", Mode: "ask"},
			{ID: "auto", Mode: "auto"},
			{ID: "turbo", Mode: "full_access"},
		},
	}
	if got := DefaultPermissionForCatalog(agyCLI, model.DefaultPermissionAuto); got != "auto" {
		t.Fatalf("agy CLI auto = %q, want auto", got)
	}
	if got := DefaultPermissionForCatalog(agyCLI, model.DefaultPermissionYOLO); got != "turbo" {
		t.Fatalf("agy CLI yolo = %q, want turbo", got)
	}

	agyManaged := model.Catalog{
		DefaultPermission: "default",
		Permissions: []model.PermissionInfo{
			{ID: "default", Mode: "ask"},
			{ID: "auto", Mode: "auto"},
			{ID: "yolo", Mode: "full_access"},
		},
	}
	if got := DefaultPermissionForCatalog(agyManaged, model.DefaultPermissionAuto); got != "auto" {
		t.Fatalf("agy managed auto = %q, want auto", got)
	}
	if got := DefaultPermissionForCatalog(agyManaged, model.DefaultPermissionYOLO); got != "yolo" {
		t.Fatalf("agy managed yolo = %q, want yolo", got)
	}

	opaqueACP := model.Catalog{
		DefaultPermission: "review-mode",
		Permissions: []model.PermissionInfo{
			{ID: "review-mode", Name: "Review"},
			{ID: "build-mode", Name: "Build"},
		},
	}
	if got := DefaultPermissionForCatalog(opaqueACP, model.DefaultPermissionAuto); got != "review-mode" {
		t.Fatalf("opaque ACP auto = %q, want review-mode", got)
	}
	if got := DefaultPermissionForCatalog(opaqueACP, model.DefaultPermissionYOLO); got != "review-mode" {
		t.Fatalf("opaque ACP yolo = %q, want review-mode", got)
	}

	namedACP := model.Catalog{
		DefaultPermission: "ask-user",
		Permissions: []model.PermissionInfo{
			{ID: "ask-user", Name: "Ask"},
			{ID: "auto-mode", Name: "Auto"},
			{ID: "yolo-mode", Name: "YOLO"},
		},
	}
	if got := DefaultPermissionForCatalog(namedACP, model.DefaultPermissionAuto); got != "auto-mode" {
		t.Fatalf("named ACP auto = %q, want auto-mode", got)
	}
	if got := DefaultPermissionForCatalog(namedACP, model.DefaultPermissionYOLO); got != "yolo-mode" {
		t.Fatalf("named ACP yolo = %q, want yolo-mode", got)
	}
}
