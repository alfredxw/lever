import { expect, test } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

test("Skills configures TRAE and Antigravity independently and offers attachment outside a runtime's sources", async ({
  page,
}) => {
  const { url, scope } = JSON.parse(
    readFileSync(
      process.env.LEVER_TEST_CONTEXT ?? "../output/e2e/context.json",
      "utf8",
    ),
  );
  const binary = (name: string) =>
    join(
      dirname(scope),
      "bin",
      process.platform === "win32" ? `${name}.exe` : name,
    );
  const localName = "trae-only-example";
  const directory = join(scope, ".trae", "skills", localName);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "SKILL.md"),
    `---\nname: ${localName}\ndescription: TRAE project Skill\n---\n`,
  );
  await page.goto(url);
  const nav = page.getByRole("navigation", { name: "主导航" });
  await expect(nav).toBeVisible();
  const post = async (path: string, data: object) => {
    const response = await page.request.post(`/api/${path}`, { data });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  };
  const connection = (name: string, command: string, args: string[]) =>
    post("providers", {
      pluginId: "lever.acp",
      contributionId: "acp",
      type: "acp",
      enabled: true,
      name,
      command: binary(command),
      args,
    });
  const trae = await connection("TRAE CLI", "traex", ["acp", "serve"]);
  const generic = await connection("Reference only", "codex", ["--acp"]);
  for (const [name, provider] of [
    ["eg trae", trae.id],
    ["lever agy", "antigravity"],
    ["generic ACP", generic.id],
  ]) {
    await post("agents", {
      name,
      profile: {
        provider,
        roots: [{ id: "primary", path: scope }],
        primaryRootId: "primary",
      },
    });
  }
  const shared = await post("skills", { name: "agent-policy-example" });
  await page.reload();
  const open = async (name: string) => {
    await nav.getByRole("button", { name: "技能", exact: true }).click();
    await page
      .getByRole("group", { name, exact: true })
      .getByRole("button", { name: "引用此技能的 Agent" })
      .click();
    return page.getByRole("dialog", { name: "引用此技能的 Agent" });
  };
  let dialog = await open(shared.name);
  const toggle = (agent: string, name: string) =>
    dialog.getByRole("switch", {
      name: `为 ${agent} 启用 ${name}`,
      exact: true,
    });
  await expect(toggle("eg trae", shared.name)).toBeChecked();
  await expect(toggle("lever agy", shared.name)).toBeChecked();
  await expect(
    dialog.getByRole("listitem").filter({ hasText: "generic ACP" }),
  ).toContainText("仅引用");
  await toggle("eg trae", shared.name).click();
  await expect(toggle("eg trae", shared.name)).not.toBeChecked();
  await page.reload();
  dialog = await open(shared.name);
  await expect(toggle("eg trae", shared.name)).not.toBeChecked();
  await expect(toggle("lever agy", shared.name)).toBeChecked();
  await page.keyboard.press("Escape");
  dialog = await open(localName);
  await expect(toggle("eg trae", localName)).toBeChecked();
  await dialog
    .getByRole("button", { name: `将 ${localName} 挂载到 lever agy` })
    .click();
  await expect(toggle("lever agy", localName)).toBeChecked();
});
