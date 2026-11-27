import assert from "node:assert/strict";
import test from "node:test";
import {
  allowsRemoteDelegation,
  canAcceptDelegations,
  defaultDelegationSettings,
  effectiveDelegationPolicy,
  effectiveMaxDelegationDepth,
} from "../src/features/agents/delegationPolicyModel.ts";

test("effectiveDelegationPolicy defaults new/unconfigured agents to none unless global default is all", () => {
  assert.equal(
    effectiveDelegationPolicy({ delegations: [] }, defaultDelegationSettings),
    "none",
  );
  assert.equal(
    effectiveDelegationPolicy({ delegations: [] }, { defaultPolicy: "all" }),
    "all",
  );
  assert.equal(
    effectiveDelegationPolicy(
      { delegationPolicy: "none", delegations: [] },
      { defaultPolicy: "all" },
    ),
    "none",
  );
});

test("effectiveDelegationPolicy preserves legacy explicit delegations as selected", () => {
  assert.equal(
    effectiveDelegationPolicy(
      { delegations: [{ agentId: "a1", confirm: false }] },
      { defaultPolicy: "all" },
    ),
    "selected",
  );
  assert.equal(
    effectiveDelegationPolicy(
      {
        delegationPolicy: "all",
        delegations: [{ agentId: "a1", confirm: true }],
      },
      defaultDelegationSettings,
    ),
    "all",
  );
});

test("canAcceptDelegations and allowsRemoteDelegation default to true and honor explicit false", () => {
  assert.equal(canAcceptDelegations({}), true);
  assert.equal(canAcceptDelegations({ acceptDelegations: true }), true);
  assert.equal(canAcceptDelegations({ acceptDelegations: false }), false);
  assert.equal(allowsRemoteDelegation({}), true);
  assert.equal(allowsRemoteDelegation({ allowRemoteDelegation: false }), false);
});

test("effectiveMaxDelegationDepth defaults to 1, inherits global 2, and honors per-agent override", () => {
  assert.equal(effectiveMaxDelegationDepth({}, defaultDelegationSettings), 1);
  assert.equal(
    effectiveMaxDelegationDepth({}, { maxDepth: 2 }),
    2,
  );
  assert.equal(
    effectiveMaxDelegationDepth({ maxDelegationDepth: 1 }, { maxDepth: 2 }),
    1,
  );
  assert.equal(
    effectiveMaxDelegationDepth({ maxDelegationDepth: 2 }, { maxDepth: 1 }),
    2,
  );
});
