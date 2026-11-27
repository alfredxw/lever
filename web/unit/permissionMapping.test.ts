import assert from "node:assert/strict";
import test from "node:test";
import type { Catalog } from "../src/api/types.gen.ts";
import {
  isAskPermission,
  recommendedUnattendedPermission,
} from "../src/features/runtime/permissionPolicy.ts";

function makeCatalog(
  provider: string,
  defaultPermission: string,
  permissions: Catalog["permissions"],
): Catalog {
  return {
    provider,
    models: [],
    permissions,
    defaultPermission,
    capabilities: {
      steering: false,
      images: false,
      files: true,
      multiRoot: false,
      mcp: true,
      skills: false,
      resume: false,
    },
  };
}

test("isAskPermission detects interactive approval modes across providers", () => {
  const codex = makeCatalog("codex", "auto_review", [
    { id: "ask", name: "", mode: "ask" },
    { id: "auto_review", name: "", mode: "auto" },
    { id: "full_access", name: "", mode: "full_access" },
  ]);
  assert.equal(isAskPermission(codex, "ask"), true);
  assert.equal(isAskPermission(codex, "auto_review"), false);
  assert.equal(isAskPermission(codex, "full_access"), false);
  assert.equal(isAskPermission(codex, ""), false);

  const pi = makeCatalog("pi", "ask", [
    { id: "ask", name: "", mode: "ask" },
    { id: "accept_edits", name: "", mode: "accept_edits" },
    { id: "full_access", name: "", mode: "full_access" },
  ]);
  assert.equal(isAskPermission(pi, ""), true);
  assert.equal(isAskPermission(pi, "accept_edits"), false);

  const agy = makeCatalog("antigravity", "default", [
    { id: "request-review", name: "", mode: "request_review" },
    { id: "default", name: "", mode: "ask" },
    { id: "auto", name: "", mode: "auto" },
    { id: "turbo", name: "", mode: "full_access" },
  ]);
  assert.equal(isAskPermission(agy, "default"), true);
  assert.equal(isAskPermission(agy, "request-review"), true);
  assert.equal(isAskPermission(agy, "auto"), false);
  assert.equal(isAskPermission(agy, "turbo"), false);

  const customAcp = makeCatalog("acp", "ask-user", [
    { id: "ask-user", name: "Ask" },
    { id: "build", name: "Build" },
  ]);
  assert.equal(isAskPermission(customAcp, "ask-user"), true);
  assert.equal(isAskPermission(customAcp, "build"), false);

  // Pre-catalog fallback.
  assert.equal(isAskPermission(undefined, "ask"), true);
  assert.equal(isAskPermission(undefined, "full_access"), false);
});

test("recommendedUnattendedPermission picks safest non-ask permission per provider", () => {
  const codex = makeCatalog("codex", "auto_review", [
    { id: "ask", name: "", mode: "ask" },
    { id: "auto_review", name: "", mode: "auto" },
    { id: "full_access", name: "", mode: "full_access" },
  ]);
  assert.equal(recommendedUnattendedPermission(codex)?.id, "auto_review");

  const pi = makeCatalog("pi", "ask", [
    { id: "ask", name: "", mode: "ask" },
    { id: "accept_edits", name: "", mode: "accept_edits" },
    { id: "full_access", name: "", mode: "full_access" },
  ]);
  assert.equal(recommendedUnattendedPermission(pi)?.id, "accept_edits");

  const agy = makeCatalog("antigravity", "default", [
    { id: "request-review", name: "", mode: "request_review" },
    { id: "default", name: "", mode: "ask" },
    { id: "auto", name: "", mode: "auto" },
    { id: "turbo", name: "", mode: "full_access" },
  ]);
  assert.equal(recommendedUnattendedPermission(agy)?.id, "auto");
  assert.equal(recommendedUnattendedPermission(agy, "auto")?.id, "auto");
  assert.equal(recommendedUnattendedPermission(agy, "yolo")?.id, "turbo");
  assert.equal(recommendedUnattendedPermission(codex, "yolo")?.id, "full_access");
  assert.equal(recommendedUnattendedPermission(pi, "yolo")?.id, "full_access");
});
