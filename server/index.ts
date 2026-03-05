import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";

const PORT = parseInt(process.env.PORT || "8080", 10);
const HOST = process.env.HOST || "0.0.0.0";

// y-websocket protocol message types
const messageSync = 0;
const messageAwareness = 1;

// Store Yjs documents by room name
const docs = new Map<string, Y.Doc>();
// Track connections per document
const conns = new Map<string, Map<WebSocket, Set<number>>>();
// Awareness instances per document
const awarenesses = new Map<string, awarenessProtocol.Awareness>();

function getYDoc(docName: string): Y.Doc {
  let doc = docs.get(docName);
  if (!doc) {
    doc = new Y.Doc();
    doc.on("update", (update: Uint8Array, _origin: unknown) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageSync);
      syncProtocol.writeUpdate(encoder, update);
      const message = encoding.toUint8Array(encoder);
      broadcastToRoom(docName, message, null);
    });
    docs.set(docName, doc);
  }
  return doc;
}

function getAwareness(docName: string): awarenessProtocol.Awareness {
  let awareness = awarenesses.get(docName);
  if (!awareness) {
    const doc = getYDoc(docName);
    awareness = new awarenessProtocol.Awareness(doc);
    awareness.on(
      "update",
      (
        { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
        _origin: unknown,
      ) => {
        const changedClients = added.concat(updated, removed);
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, messageAwareness);
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(awareness!, changedClients),
        );
        const message = encoding.toUint8Array(encoder);
        broadcastToRoom(docName, message, null);
      },
    );
    awarenesses.set(docName, awareness);
  }
  return awareness;
}

function broadcastToRoom(docName: string, message: Uint8Array, exclude: WebSocket | null) {
  const roomConns = conns.get(docName);
  if (!roomConns) return;
  for (const [conn] of roomConns) {
    if (conn !== exclude && conn.readyState === WebSocket.OPEN) {
      conn.send(message);
    }
  }
}

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("MarkFlow y-websocket server");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  const docName = req.url?.slice(1) || "default";
  const doc = getYDoc(docName);
  const awareness = getAwareness(docName);

  if (!conns.has(docName)) {
    conns.set(docName, new Map());
  }
  const controlledIds = new Set<number>();
  conns.get(docName)!.set(ws, controlledIds);

  // Send sync step 1
  {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageSync);
    syncProtocol.writeSyncStep1(encoder, doc);
    ws.send(encoding.toUint8Array(encoder));
  }

  // Send current awareness states
  {
    const states = awareness.getStates();
    if (states.size > 0) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageAwareness);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(awareness, Array.from(states.keys())),
      );
      ws.send(encoding.toUint8Array(encoder));
    }
  }

  ws.on("message", (data: ArrayBuffer) => {
    try {
      const message = new Uint8Array(data as ArrayBuffer);
      const decoder = decoding.createDecoder(message);
      const messageType = decoding.readVarUint(decoder);

      switch (messageType) {
        case messageSync: {
          const encoder = encoding.createEncoder();
          encoding.writeVarUint(encoder, messageSync);
          syncProtocol.readSyncMessage(decoder, encoder, doc, null);
          if (encoding.length(encoder) > 1) {
            ws.send(encoding.toUint8Array(encoder));
          }
          break;
        }
        case messageAwareness: {
          const update = decoding.readVarUint8Array(decoder);
          awarenessProtocol.applyAwarenessUpdate(awareness, update, ws);
          break;
        }
      }
    } catch (err) {
      console.error("Error handling message:", err);
    }
  });

  ws.on("close", () => {
    const roomConns = conns.get(docName);
    if (roomConns) {
      roomConns.delete(ws);
      if (roomConns.size === 0) {
        conns.delete(docName);
      }
    }

    // Remove awareness states for this connection
    awarenessProtocol.removeAwarenessStates(awareness, Array.from(controlledIds), null);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`y-websocket server running on ${HOST}:${PORT}`);
});
