// Passed as an explicit, reviewed Node -e argument; no package install or repository startup hook.
export const STDIO_FIXTURE = String.raw`
const { createInterface } = require("node:readline");
const { spawn } = require("node:child_process");
const lines = createInterface({ input: process.stdin });
process.stdin.on("end", () => process.exit(0));
lines.on("line", line => {
  let request;
  try { request = JSON.parse(line); } catch { process.exit(2); }
  if (request.id === undefined) return;
  let result;
  if (request.method === "initialize") result = { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } };
  else if (request.method === "tools/list") result = { tools: [{ name: "inspect", description: "Inspect this fixture process", inputSchema: { type: "object", properties: { mode: { type: "string" } } } }] };
  else if (request.method === "tools/call") {
    const mode = request.params.arguments.mode;
    if (mode === "flood") { process.stdout.write("x".repeat(2 * 1024 * 1024 + 1)); return; }
    if (mode === "stderr") { process.stderr.write("x".repeat(9 * 1024 * 1024)); return; }
    if (mode === "hold") { require("node:fs").writeFileSync("hold.pid", String(process.pid)); setInterval(() => {}, 1000); return; }
    if (mode === "orphan") {
      process.stdin.removeAllListeners("end");
      require("node:fs").writeFileSync("orphan.json", JSON.stringify({ pid: process.pid, group: process.ppid }));
      setInterval(() => {}, 1000);
      return;
    }
    let child;
    if (mode === "child") child = spawn(process.execPath, ["-e", 'process.on("SIGTERM",()=>{}); console.log("ready"); setInterval(()=>{},1000)'], { stdio: ["ignore", "pipe", "ignore"] });
    const reply = () => {
      const text = JSON.stringify({ pid: process.pid, child: child?.pid, cwd: process.cwd(), home: process.env.HOME, env: process.env });
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text }] } }) + "\n");
    };
    if (child) child.stdout.once("data", reply); else reply();
    return;
  } else { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "unknown method" } }) + "\n"); return; }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
});
`;
