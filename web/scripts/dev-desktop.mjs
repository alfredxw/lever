import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";

const root = fileURLToPath(new URL("../../", import.meta.url));
let vite;
const listener = createServer((request, response) => {
  if (vite) vite.middlewares(request, response);
  else response.writeHead(503).end();
});
await once(listener.listen(0, "127.0.0.1"), "listening");

try {
  const { port } = listener.address();
  vite = await createViteServer({
    root: fileURLToPath(new URL("../", import.meta.url)),
    mode: "desktop",
    cacheDir: "node_modules/.vite-desktop",
    server: {
      host: "127.0.0.1",
      port,
      middlewareMode: true,
      hmr: { server: listener },
    },
  });
  const origin = `http://127.0.0.1:${port}`;
  console.log(
    `Desktop frontend: ${origin} (proxied through the desktop backend)`,
  );
  // macOS uses the executable name for a desktop launched outside an app bundle.
  const executable = join(
    root,
    "bin/desktop",
    process.platform === "win32" ? "Lever.exe" : "Lever",
  );
  const args = process.argv.slice(2);
  if (args[0] === "--prebuilt") {
    args.shift();
  } else {
    const build = spawn(
      "go",
      ["build", "-tags", "dev", "-o", executable, "./cmd/lever-desktop"],
      { cwd: root, stdio: "inherit" },
    );
    const [buildCode] = await once(build, "exit");
    if (buildCode !== 0) throw new Error("Desktop build failed");
  }
  const child = spawn(
    executable,
    ["--dev-origin", origin, ...args],
    { cwd: root, stdio: "inherit", detached: true },
  );
  // Signal the desktop window's process group. Its backend runs independently.
  // Vite stays up until the window quits.
  const stop = () => {
    try {
      process.kill(-child.pid, "SIGINT");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    const [code] = await once(child, "exit");
    process.exitCode = code ?? 1;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
} finally {
  try {
    await vite?.close();
  } finally {
    listener.closeAllConnections();
    await new Promise((resolve) => listener.close(resolve));
  }
}
