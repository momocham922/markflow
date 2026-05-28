/**
 * MCP (Model Context Protocol) client for MarkFlow.
 * Spawns MCP server processes via Tauri shell and communicates via JSON-RPC over stdio.
 */

export interface McpServerConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  serverId: string;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface McpConnection {
  config: McpServerConfig;
  pid: number;
  write: (data: string) => Promise<void>;
  kill: () => Promise<void>;
  pendingRequests: Map<number, {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
  }>;
  nextId: number;
  tools: McpTool[];
}

const connections = new Map<string, McpConnection>();

async function sendRequest(conn: McpConnection, method: string, params?: Record<string, unknown>): Promise<unknown> {
  const id = conn.nextId++;
  const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
  const message = JSON.stringify(request) + "\n";

  return new Promise((resolve, reject) => {
    conn.pendingRequests.set(id, { resolve, reject });
    conn.write(message).catch(reject);
    // Timeout after 30 seconds
    setTimeout(() => {
      if (conn.pendingRequests.has(id)) {
        conn.pendingRequests.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }
    }, 30000);
  });
}

function handleStdoutLine(conn: McpConnection, line: string) {
  if (!line.trim()) return;
  try {
    const response: JsonRpcResponse = JSON.parse(line);
    if (response.id != null && conn.pendingRequests.has(response.id)) {
      const { resolve, reject } = conn.pendingRequests.get(response.id)!;
      conn.pendingRequests.delete(response.id);
      if (response.error) {
        reject(new Error(response.error.message));
      } else {
        resolve(response.result);
      }
    }
  } catch {
    // Not JSON-RPC, ignore
  }
}

export async function connectServer(config: McpServerConfig): Promise<McpTool[]> {
  if (connections.has(config.id)) {
    await disconnectServer(config.id);
  }

  const { Command } = await import("@tauri-apps/plugin-shell");

  const cmd = Command.create(config.command, config.args);

  const conn: McpConnection = {
    config,
    pid: 0,
    write: async () => {},
    kill: async () => {},
    pendingRequests: new Map(),
    nextId: 1,
    tools: [],
  };

  let stdoutBuf = "";

  cmd.stdout.on("data", (data: string) => {
    stdoutBuf += data;
    const lines = stdoutBuf.split("\n");
    stdoutBuf = lines.pop() || "";
    for (const line of lines) {
      handleStdoutLine(conn, line);
    }
  });

  cmd.stderr.on("data", (data: string) => {
    console.warn(`[MCP ${config.name}] stderr:`, data);
  });

  const child = await cmd.spawn();
  conn.pid = child.pid;
  conn.write = (data: string) => child.write(data);
  conn.kill = () => child.kill();

  connections.set(config.id, conn);

  // Initialize MCP connection
  try {
    await sendRequest(conn, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "MarkFlow", version: "1.0" },
    });

    // Send initialized notification (no response expected)
    const notif = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n";
    await conn.write(notif);

    // List available tools
    const result = await sendRequest(conn, "tools/list") as { tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> };
    conn.tools = (result.tools || []).map((t) => ({
      name: t.name,
      description: t.description || "",
      inputSchema: t.inputSchema || {},
      serverId: config.id,
    }));

    return conn.tools;
  } catch (err) {
    await disconnectServer(config.id);
    throw err;
  }
}

export async function disconnectServer(serverId: string): Promise<void> {
  const conn = connections.get(serverId);
  if (!conn) return;

  try {
    await conn.kill();
  } catch {
    // Process may already be dead
  }
  connections.delete(serverId);
}

export async function callTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
  const conn = connections.get(serverId);
  if (!conn) throw new Error(`MCP server not connected: ${serverId}`);

  const result = await sendRequest(conn, "tools/call", { name: toolName, arguments: args });
  return result;
}

export function getAllTools(): McpTool[] {
  const tools: McpTool[] = [];
  for (const conn of connections.values()) {
    tools.push(...conn.tools);
  }
  return tools;
}

export function getConnectedServerIds(): string[] {
  return Array.from(connections.keys());
}

export async function disconnectAll(): Promise<void> {
  for (const id of connections.keys()) {
    await disconnectServer(id);
  }
}

/** Convert MCP tools to Claude API tool format */
export function toClaudeTools(tools: McpTool[]): Array<{
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}> {
  return tools.map((t) => ({
    name: `mcp_${t.serverId}_${t.name}`,
    description: `[MCP: ${t.serverId}] ${t.description}`,
    input_schema: t.inputSchema,
  }));
}

/** Parse a Claude tool_use name back to serverId + toolName */
export function parseClaudeToolName(name: string): { serverId: string; toolName: string } | null {
  const match = name.match(/^mcp_([^_]+)_(.+)$/);
  if (!match) return null;
  return { serverId: match[1], toolName: match[2] };
}
