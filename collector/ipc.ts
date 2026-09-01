import { createConnection, createServer, type Server, type Socket } from "node:net";
import type { CollectorCommand, CommandResponse } from "./types.js";

export type CommandHandler = (command: CollectorCommand) => Promise<CommandResponse>;

export async function listen(endpoint: string, handler: CommandHandler): Promise<Server> {
  const server = createServer((socket) => handleSocket(socket, handler));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => { server.off("error", reject); resolve(); });
  });
  return server;
}

function handleSocket(socket: Socket, handler: CommandHandler): void {
  socket.setEncoding("utf8");
  let input = "";
  socket.on("data", (part: string) => {
    input += part;
    const newline = input.indexOf("\n");
    if (newline < 0) return;
    const line = input.slice(0, newline);
    socket.pause();
    void dispatch(line, handler).then((response) => socket.end(`${JSON.stringify(response)}\n`));
  });
}

async function dispatch(line: string, handler: CommandHandler): Promise<CommandResponse> {
  try { return await handler(JSON.parse(line) as CollectorCommand); }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
}

export async function request(endpoint: string, command: CollectorCommand, timeoutMs = 2_000): Promise<CommandResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    let output = "";
    const timer = setTimeout(() => socket.destroy(new Error("ipc_timeout")), timeoutMs);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(command)}\n`));
    socket.on("data", (part: string) => { output += part; });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    socket.once("end", () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(output.trim()) as CommandResponse); }
      catch { reject(new Error("invalid_ipc_response")); }
    });
  });
}
