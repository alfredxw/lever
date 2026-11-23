import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";

const root = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
const prebuilt = args[0] === "--prebuilt";
if (prebuilt) args.shift();
const frontendRestart =
  process.platform === "darwin" && args[0] === "--reload-on-sighup";
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
  if (!prebuilt) {
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
  let restarting;
  const restartFrontend = () => {
    // Keep the proxy origin stable and reload even if the HMR client never ran.
    restarting ??= vite
      .restart()
      .then(() => child.kill("SIGHUP"))
      .catch((error) => console.error("Unable to restart the frontend:", error))
      .finally(() => {
        restarting = undefined;
      });
  };
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
  if (frontendRestart) process.on("SIGUSR2", restartFrontend);
  try {
    const [code] = await once(child, "exit");
    process.exitCode = code ?? 1;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    if (frontendRestart) process.off("SIGUSR2", restartFrontend);
    await restarting;
  }
} finally {
  try {
    await vite?.close();
  } finally {
    listener.closeAllConnections();
    await new Promise((resolve) => listener.close(resolve));
  }
}
