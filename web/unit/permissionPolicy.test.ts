import assert from "node:assert/strict";
import test from "node:test";
import type { Catalog } from "../src/api/types.gen.ts";
import {
  normalizeAgentPermissionPolicy,
  resolveAgentPermissionForCatalog,
} from "../src/features/runtime/permissionPolicy.ts";

const codexCatalog: Catalog = {
  provider: "codex",
  models: [],
  defaultPermission: "auto_review",
  permissions: [
    { id: "ask", name: "Ask", mode: "ask" },
    { id: "auto_review", name: "Approve for me", mode: "auto" },
    { id: "full_access", name: "Full access", mode: "full_access" },
  ],
  legacyPermissions: [{ id: "read_only", name: "Read-only", mode: "read_only" }],
  capabilities: {
    steering: true,
    images: true,
    files: true,
    multiRoot: true,
    mcp: true,
    skills: true,
    resume: true,
  },
};

const claudeCatalog: Catalog = {
  ...codexCatalog,
  provider: "claude",
  defaultPermission: "auto",
  permissions: [
    { id: "ask", name: "Ask", mode: "ask" },
    { id: "accept_edits", name: "Accept edits", mode: "accept_edits" },
    { id: "auto", name: "Auto", mode: "auto" },
    { id: "plan", name: "Plan", mode: "plan" },
    { id: "full_access", name: "Full access", mode: "full_access" },
  ],
  legacyPermissions: [{ id: "dont_ask", name: "Don't ask", mode: "dont_ask" }],
};

const piCatalog: Catalog = {
  ...codexCatalog,
  provider: "pi",
  defaultPermission: "accept_edits",
  permissions: [
    { id: "ask", name: "Ask", mode: "ask" },
    { id: "accept_edits", name: "Accept edits", mode: "accept_edits" },
    { id: "full_access", name: "Full access", mode: "full_access" },
  ],
  legacyPermissions: [],
};

const antigravityCatalog: Catalog = {
  ...codexCatalog,
  provider: "antigravity",
  defaultPermission: "auto",
  permissions: [
    { id: "request-review", name: "Request Review", mode: "request_review" },
    { id: "default", name: "Default", mode: "ask" },
    { id: "auto", name: "Auto", mode: "auto" },
    { id: "turbo", name: "Turbo", mode: "full_access" },
  ],
  legacyPermissions: [{ id: "plan", name: "Plan", mode: "plan" }],
};

test("normalizeAgentPermissionPolicy maps canonical and legacy permission IDs cleanly", () => {
  assert.equal(normalizeAgentPermissionPolicy(""), "");
  assert.equal(normalizeAgentPermissionPolicy(undefined), "");
  assert.equal(normalizeAgentPermissionPolicy("read_only"), "read_only");
  assert.equal(normalizeAgentPermissionPolicy("plan"), "read_only");
  assert.equal(normalizeAgentPermissionPolicy("request-review"), "read_only");
  assert.equal(normalizeAgentPermissionPolicy("ask"), "ask");
  assert.equal(normalizeAgentPermissionPolicy("default"), "ask");
  assert.equal(normalizeAgentPermissionPolicy("auto"), "auto");
  assert.equal(normalizeAgentPermissionPolicy("auto_review"), "auto");
  assert.equal(normalizeAgentPermissionPolicy("accept_edits"), "auto");
  assert.equal(normalizeAgentPermissionPolicy("full_access"), "full_access");
  assert.equal(normalizeAgentPermissionPolicy("turbo"), "full_access");
  assert.equal(normalizeAgentPermissionPolicy("yolo"), "full_access");
});

test("resolveAgentPermissionForCatalog maps inherit-global and canonical policies across every provider", () => {
  // Empty ("") follows each catalog's global defaultPermission.
  assert.equal(resolveAgentPermissionForCatalog("", codexCatalog, "codex"), "auto_review");
  assert.equal(resolveAgentPermissionForCatalog("", claudeCatalog, "claude"), "auto");
  assert.equal(resolveAgentPermissionForCatalog("", piCatalog, "pi"), "accept_edits");
  assert.equal(resolveAgentPermissionForCatalog("", antigravityCatalog, "antigravity"), "auto");

  // read_only maps to read_only (codex), plan (claude), ask (pi), request-review (antigravity).
  assert.equal(resolveAgentPermissionForCatalog("read_only", codexCatalog, "codex"), "read_only");
  assert.equal(resolveAgentPermissionForCatalog("read_only", claudeCatalog, "claude"), "plan");
  assert.equal(resolveAgentPermissionForCatalog("read_only", piCatalog, "pi"), "ask");
  assert.equal(resolveAgentPermissionForCatalog("read_only", antigravityCatalog, "antigravity"), "request-review");

  // ask maps across all providers.
  assert.equal(resolveAgentPermissionForCatalog("ask", codexCatalog, "codex"), "ask");
  assert.equal(resolveAgentPermissionForCatalog("ask", claudeCatalog, "claude"), "ask");
  assert.equal(resolveAgentPermissionForCatalog("ask", piCatalog, "pi"), "ask");
  assert.equal(resolveAgentPermissionForCatalog("ask", antigravityCatalog, "antigravity"), "default");

  // auto maps across all providers.
  assert.equal(resolveAgentPermissionForCatalog("auto", codexCatalog, "codex"), "auto_review");
  assert.equal(resolveAgentPermissionForCatalog("auto", claudeCatalog, "claude"), "auto");
  assert.equal(resolveAgentPermissionForCatalog("auto", piCatalog, "pi"), "accept_edits");
  assert.equal(resolveAgentPermissionForCatalog("auto", antigravityCatalog, "antigravity"), "auto");

  // full_access maps across all providers.
  assert.equal(resolveAgentPermissionForCatalog("full_access", codexCatalog, "codex"), "full_access");
  assert.equal(resolveAgentPermissionForCatalog("full_access", claudeCatalog, "claude"), "full_access");
  assert.equal(resolveAgentPermissionForCatalog("full_access", piCatalog, "pi"), "full_access");
  assert.equal(resolveAgentPermissionForCatalog("full_access", antigravityCatalog, "antigravity"), "turbo");

  // Legacy native ID preserved on native provider and mapped on another provider.
  assert.equal(resolveAgentPermissionForCatalog("accept_edits", claudeCatalog, "claude"), "accept_edits");
  assert.equal(resolveAgentPermissionForCatalog("accept_edits", codexCatalog, "codex"), "auto_review");

  // Static fallback without catalog mirrors provider mappings.
  assert.equal(resolveAgentPermissionForCatalog("read_only", undefined, "claude"), "plan");
  assert.equal(resolveAgentPermissionForCatalog("read_only", undefined, "pi"), "ask");
  assert.equal(resolveAgentPermissionForCatalog("auto", undefined, "codex"), "auto_review");
  assert.equal(resolveAgentPermissionForCatalog("full_access", undefined, "antigravity"), "turbo");
});
