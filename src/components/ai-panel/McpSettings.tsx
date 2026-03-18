import { useState, useEffect, useCallback } from "react";
import { X, Plus, Trash2, Power, PowerOff, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { McpServerConfig } from "@/services/mcp";
import { connectServer, disconnectServer, getConnectedServerIds } from "@/services/mcp";
import * as db from "@/services/database";
import { useAuthStore } from "@/stores/auth-store";
import { saveUserSettingsToFirestore } from "@/services/firebase";

interface McpSettingsProps {
  open: boolean;
  onClose: () => void;
  onToolsChanged: () => void;
}

const MCP_SETTINGS_KEY = "mcp_servers";

export async function loadMcpConfigs(): Promise<McpServerConfig[]> {
  const raw = await db.getSetting(MCP_SETTINGS_KEY).catch(() => null);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function saveMcpConfigs(configs: McpServerConfig[]): Promise<void> {
  const json = JSON.stringify(configs);
  await db.setSetting(MCP_SETTINGS_KEY, json);
  // Cloud sync
  const uid = useAuthStore.getState().user?.uid;
  if (uid) {
    saveUserSettingsToFirestore(uid, { mcp_servers: json }).catch(() => {});
  }
}

export function McpSettings({ open, onClose, onToolsChanged }: McpSettingsProps) {
  const [configs, setConfigs] = useState<McpServerConfig[]>([]);
  const [connectedIds, setConnectedIds] = useState<Set<string>>(new Set());
  const [connecting, setConnecting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addMode, setAddMode] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCommand, setNewCommand] = useState("");
  const [newArgs, setNewArgs] = useState("");

  const refreshConnected = useCallback(() => {
    setConnectedIds(new Set(getConnectedServerIds()));
  }, []);

  useEffect(() => {
    if (open) {
      loadMcpConfigs().then(setConfigs);
      refreshConnected();
    }
  }, [open, refreshConnected]);

  const handleAdd = async () => {
    if (!newName.trim() || !newCommand.trim()) return;
    const config: McpServerConfig = {
      id: crypto.randomUUID().slice(0, 8),
      name: newName.trim(),
      command: newCommand.trim(),
      args: newArgs.trim() ? newArgs.trim().split(/\s+/) : [],
      enabled: true,
    };
    const updated = [...configs, config];
    setConfigs(updated);
    await saveMcpConfigs(updated);
    setAddMode(false);
    setNewName("");
    setNewCommand("");
    setNewArgs("");
  };

  const handleRemove = async (id: string) => {
    await disconnectServer(id);
    const updated = configs.filter((c) => c.id !== id);
    setConfigs(updated);
    await saveMcpConfigs(updated);
    refreshConnected();
    onToolsChanged();
  };

  const handleToggle = async (config: McpServerConfig) => {
    setError(null);
    setConnecting(config.id);
    try {
      if (connectedIds.has(config.id)) {
        await disconnectServer(config.id);
      } else {
        await connectServer(config);
      }
      refreshConnected();
      onToolsChanged();
    } catch (err) {
      setError(`${config.name}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setConnecting(null);
    }
  };

  if (!open) return null;

  return (
    <div className="absolute inset-0 z-50 flex flex-col bg-background">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-sm font-medium">MCP Servers</span>
        <Button variant="ghost" size="icon" className="h-6 w-6 cursor-pointer" onClick={onClose}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="flex-1 p-3 flex flex-col gap-2 min-h-0 overflow-y-auto">
        <p className="text-[10px] text-muted-foreground">
          Connect MCP (Model Context Protocol) servers to give Claude access to external tools.
        </p>

        {error && (
          <div className="text-[10px] text-destructive bg-destructive/10 rounded px-2 py-1">
            {error}
          </div>
        )}

        {configs.length === 0 && !addMode && (
          <p className="text-xs text-muted-foreground text-center py-4">
            No servers configured.
          </p>
        )}

        {configs.map((config) => {
          const isConnected = connectedIds.has(config.id);
          const isConnecting = connecting === config.id;
          return (
            <div
              key={config.id}
              className="flex items-center gap-2 rounded border border-border px-2 py-1.5"
            >
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium truncate">{config.name}</div>
                <div className="text-[10px] text-muted-foreground truncate">
                  {config.command} {config.args.join(" ")}
                </div>
              </div>
              <Button
                variant={isConnected ? "secondary" : "ghost"}
                size="icon"
                className="h-6 w-6 shrink-0 cursor-pointer"
                onClick={() => handleToggle(config)}
                disabled={isConnecting}
                title={isConnected ? "Disconnect" : "Connect"}
              >
                {isConnecting ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : isConnected ? (
                  <Power className="h-3 w-3 text-emerald-500" />
                ) : (
                  <PowerOff className="h-3 w-3" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0 cursor-pointer"
                onClick={() => handleRemove(config.id)}
                title="Remove"
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          );
        })}

        {addMode ? (
          <div className="rounded border border-border p-2 space-y-2">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Server name"
              className="w-full rounded border border-input bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-ring"
            />
            <input
              value={newCommand}
              onChange={(e) => setNewCommand(e.target.value)}
              placeholder="Command (e.g. npx)"
              className="w-full rounded border border-input bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-ring"
            />
            <input
              value={newArgs}
              onChange={(e) => setNewArgs(e.target.value)}
              placeholder="Arguments (space-separated)"
              className="w-full rounded border border-input bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-ring"
            />
            <div className="flex gap-2 justify-end">
              <Button variant="ghost" size="sm" className="text-xs cursor-pointer" onClick={() => setAddMode(false)}>
                Cancel
              </Button>
              <Button size="sm" className="text-xs cursor-pointer" onClick={handleAdd} disabled={!newName.trim() || !newCommand.trim()}>
                Add
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 text-xs cursor-pointer"
            onClick={() => setAddMode(true)}
          >
            <Plus className="h-3 w-3" />
            Add Server
          </Button>
        )}
      </div>
    </div>
  );
}
