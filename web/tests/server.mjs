import { execFileSync, spawn } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  linkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const temp = mkdtempSync(join(tmpdir(), "lever-browser-"));
const bin = join(temp, "bin");
const scope = join(temp, "workspace");
const fixtureHome = join(temp, "home");
mkdirSync(bin);
mkdirSync(scope);
mkdirSync(fixtureHome);
const skillDir = join(scope, ".agents", "skills", "fixture-review");
mkdirSync(skillDir, { recursive: true });
writeFileSync(
  join(skillDir, "SKILL.md"),
  "---\nname: fixture-review\ndescription: Review the selected files\n---\nReview carefully.\n",
);
const relatedSkill = join(scope, ".agents", "skills", "a-related-skill");
mkdirSync(relatedSkill, { recursive: true });
writeFileSync(
  join(relatedSkill, "SKILL.md"),
  "---\nname: a-related-skill\ndescription: Alternative to fixture-review\n---\nAlternative instructions.\n",
);
mkdirSync(join(scope, "docs"));
writeFileSync(join(scope, "docs", "design notes.md"), "Design notes\n");
writeFileSync(join(scope, ".gitignore"), "ignored.txt\n");
writeFileSync(join(scope, "ignored.txt"), "Not a suggestion\n");
const otherScope = join(temp, "ordinary-workspace");
mkdirSync(otherScope);
writeFileSync(join(otherScope, "hello.go"), "package second\n");
mkdirSync(join(otherScope, "node_modules"));
writeFileSync(
  join(otherScope, "node_modules", "hidden.go"),
  "package ignored\n",
);
const skill = join(temp, "pinned-review");
mkdirSync(skill);
writeFileSync(
  join(skill, "SKILL.md"),
  "---\nname: pinned-review\ndescription: Agent review skill\n---\nOriginal skill.\n",
);
const extension = process.platform === "win32" ? ".exe" : "";
execFileSync(
  "go",
  [
    "build",
    "-o",
    join(bin, `codex${extension}`),
    "./internal/testutil/fakeruntime",
  ],
  { cwd: repo },
);
linkSync(join(bin, `codex${extension}`), join(bin, `claude${extension}`));
linkSync(join(bin, `codex${extension}`), join(bin, `agy${extension}`));
linkSync(join(bin, `codex${extension}`), join(bin, `traex${extension}`));
linkSync(join(bin, `codex${extension}`), join(bin, `pi${extension}`));
linkSync(join(bin, `codex${extension}`), join(bin, `dsh${extension}`));
const pluginDirectory = join(temp, "sample-plugin");
mkdirSync(pluginDirectory);
writeFileSync(
  join(pluginDirectory, "lever-plugin.json"),
  JSON.stringify({
    manifestVersion: 1,
    id: "example.browser-agent",
    name: "Browser Agent",
    version: "1.0.0",
    contributes: {
      providers: [
        {
          id: "agent",
          name: "Browser Agent",
          driver: "acp",
          command: join(bin, `codex${extension}`),
          args: ["--acp", "browser"],
        },
      ],
    },
  }),
);

execFileSync(
  "go",
  ["build", "-o", join(bin, `lever${extension}`), "./cmd/lever"],
  { cwd: repo },
);
writeFileSync(
  join(scope, "hello.go"),
  'package hello\n\nfunc Greeting() string { return "hello" }\n',
);
execFileSync("git", ["init", "-q"], { cwd: scope });
execFileSync("git", ["add", "."], { cwd: scope });
execFileSync(
  "git",
  [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "Initial",
  ],
  { cwd: scope },
);
writeFileSync(
  join(scope, "hello.go"),
  'package hello\n\nfunc Greeting() string { return "hello Lever" }\n',
);
const skillRepo = join(temp, "skill-repo");
mkdirSync(skillRepo);
const gitSshShim =
  process.platform !== "win32" && !process.env.GIT_SSH_COMMAND
    ? join(bin, "git-ssh-fixture.sh")
    : undefined;
if (gitSshShim) {
  writeFileSync(
    gitSshShim,
    `#!/bin/sh\nexec git-upload-pack "${skillRepo}"\n`,
    { mode: 0o700 },
  );
}
const child = spawn(
  join(bin, `lever${extension}`),
  [
    "--data-dir",
    join(temp, "data"),
    "--listen",
    `127.0.0.1:${process.env.LEVER_TEST_PORT ?? "4789"}`,
    ...(process.env.LEVER_TEST_DEV_ORIGIN
      ? ["--dev-origin", process.env.LEVER_TEST_DEV_ORIGIN]
      : []),
  ],
  {
    env: {
      ...process.env,
      HOME: fixtureHome,
      USERPROFILE: fixtureHome,
      CODEX_HOME: join(fixtureHome, ".codex"),
      CLAUDE_CONFIG_DIR: join(fixtureHome, ".claude"),
      PATH: `${bin}${delimiter}${process.env.PATH}`,
      LEVER_CODEX_PATH: join(bin, `codex${extension}`),
      LEVER_CLAUDE_PATH: join(bin, `claude${extension}`),
      LEVER_ANTIGRAVITY_PATH: join(bin, `agy${extension}`),
      LEVER_PI_PATH: join(bin, `pi${extension}`),
      LEVER_DSH_PATH: join(bin, `dsh${extension}`),
      ...(gitSshShim
        ? { GIT_SSH_COMMAND: gitSshShim, GIT_SSH_VARIANT: "ssh" }
        : {}),
    },
    stdio: ["ignore", "pipe", "inherit"],
  },
);
let output = "";
let initialized = false;
child.stdout.on("data", (buffer) => {
  output += buffer.toString();
  const match = output.match(/Lever: (http[^\s]+)/);
  if (match && !initialized) {
    initialized = true;
    const ready = async () => {
      const pairUrl = new URL(match[1]);
      const token = new URLSearchParams(pairUrl.hash.slice(1)).get("token");
      if (process.env.LEVER_TEST_PENDING_PERMISSION_SETUP !== "1" && token) {
        const res = await fetch(`${pairUrl.origin}/api/settings/permissions`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ defaultMode: "auto" }),
        });
        if (!res.ok) {
          throw new Error(
            `Failed to initialize fixture permission mode: ${res.status} ${await res.text()}`,
          );
        }
      }
      mkdirSync(resolve(repo, "output/e2e"), { recursive: true });
      writeFileSync(
        process.env.LEVER_TEST_CONTEXT ??
          resolve(repo, "output/e2e/context.json"),
        JSON.stringify({
          url: match[1],
          bin,
          scope,
          skill,
          skillRepo,
          otherScope,
          pluginDirectory,
        }),
      );
      console.log("Lever browser fixture ready");
    };
    void ready().catch((error) => {
      console.error(error);
      child.kill("SIGTERM");
      process.exit(1);
    });
  }
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    child.kill("SIGTERM");
  });
child.on("exit", (code) => {
  rmSync(temp, { recursive: true, force: true });
  process.exit(code ?? 0);
});
