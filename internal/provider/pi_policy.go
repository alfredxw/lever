package provider

import (
	_ "embed"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

//go:embed pi_policy.mjs
var piPolicyExtension []byte

var piFastTiers = []string{"priority", "fast"}
var piPermissions = []string{"ask", "accept_edits", "full_access"}

const piDefaultPermission = "ask"

func piModelFast(model object) bool {
	return slices.ContainsFunc(arr(model["serviceTiers"]), func(tier any) bool {
		return slices.Contains(piFastTiers, str(obj(tier)["id"]))
	})
}

func preparePiPolicy(in Input) (string, []string, error) {
	permission := in.Selection.Permission
	if permission == "" {
		permission = piDefaultPermission
	}
	if !slices.Contains(piPermissions, permission) {
		return "", nil, errors.New("Unsupported Pi tool policy")
	}
	if permission == "full_access" && !in.Selection.Fast {
		return "", nil, nil
	}
	dir, err := os.MkdirTemp(in.Assets, ".pi-policy-")
	if err != nil {
		return "", nil, err
	}
	if err := os.WriteFile(filepath.Join(dir, "policy.mjs"), piPolicyExtension, 0600); err != nil {
		os.RemoveAll(dir)
		return "", nil, err
	}
	tiers := ""
	if in.Selection.Fast {
		tiers = strings.Join(piFastTiers, ",")
	}
	return dir, []string{"LEVER_PI_POLICY=" + permission, "LEVER_PI_POLICY_READY=" + filepath.Join(dir, "ready"), "LEVER_PI_FAST_TIERS=" + tiers}, nil
}
