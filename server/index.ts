import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import { initializeApp, cert, type ServiceAccount } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

// ─── Firebase Admin ─────────────────────────────────────────────
// Uses GOOGLE_APPLICATION_CREDENTIALS or default credentials on Cloud Run
try {
  initializeApp();
} catch {
  // Already initialized
}
const auth = getAuth();
const db = getFirestore();
const COLLECTION = "yjs_snapshots";

const PORT = parseInt(process.env.PORT || "8080", 10);
const HOST = process.env.HOST || "0.0.0.0";

// y-websocket protocol message types
const messageSync = 0;
const messageAwareness = 1;

// Store Yjs documents by room name (value is a Promise to prevent race conditions)
const docs = new Map<string, Y.Doc>();
const docLoading = new Map<string, Promise<Y.Doc>>();
// Track connections per document
const conns = new Map<string, Map<WebSocket, Set<number>>>();
// Awareness instances per document
const awarenesses = new Map<string, awarenessProtocol.Awareness>();
// Debounce timers for persistence
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

// ─── Firestore Persistence ──────────────────────────────────────

async function loadSnapshot(docName: string): Promise<Uint8Array | null> {
  try {
    const snap = await db.collection(COLLECTION).doc(docName).get();
    if (snap.exists) {
      const data = snap.data();
      if (data?.snapshot) {
        // Firestore stores as base64 string
        return new Uint8Array(Buffer.from(data.snapshot, "base64"));
      }
    }
  } catch (err) {
    console.error(`Failed to load snapshot for ${docName}:`, err);
  }
  return null;
}

async function saveSnapshot(docName: string, doc: Y.Doc): Promise<void> {
  try {
    const state = Y.encodeStateAsUpdate(doc);
    await db.collection(COLLECTION).doc(docName).set({
      snapshot: Buffer.from(state).toString("base64"),
      updatedAt: new Date(),
    });

    // Also update the documents collection content so Firestore stays current
    // docName format: "markflow-{docId}"
    const docId = docName.replace(/^markflow-/, "");
    if (docId && docId !== docName) {
      const content = doc.getText("codemirror").toString();
      const docRef = db.collection("documents").doc(docId);
      const snap = await docRef.get();
      if (snap.exists) {
        await docRef.update({
          content,
          updatedAt: new Date(),
        });
      }
    }
  } catch (err) {
    console.error(`Failed to save snapshot for ${docName}:`, err);
  }
}

function scheduleSave(docName: string, doc: Y.Doc) {
  const existing = saveTimers.get(docName);
  if (existing) clearTimeout(existing);
  // Debounce: save 2s after the last update
  const timer = setTimeout(() => {
    saveTimers.delete(docName);
    saveSnapshot(docName, doc);
  }, 2000);
  saveTimers.set(docName, timer);
}

// ─── Yjs Document Management ────────────────────────────────────

function getYDoc(docName: string): Promise<Y.Doc> {
  const existing = docs.get(docName);
  if (existing) return Promise.resolve(existing);

  // Deduplicate concurrent loads: return the same promise if already loading
  const loading = docLoading.get(docName);
  if (loading) return loading;

  const promise = (async () => {
    const doc = new Y.Doc();

    // Restore from Firestore before accepting connections
    const snapshot = await loadSnapshot(docName);
    if (snapshot) {
      Y.applyUpdate(doc, snapshot);
    }

    // Fallback: if no snapshot exists, seed Y.Text from Firestore documents collection.
    // This ensures the server always has the initial content so clients don't need to seed.
    const ytext = doc.getText("codemirror");
    if (!ytext.toString().trim()) {
      const docId = docName.replace(/^markflow-/, "");
      if (docId && docId !== docName) {
        try {
          const docRef = db.collection("documents").doc(docId);
          const docSnap = await docRef.get();
          if (docSnap.exists) {
            const data = docSnap.data();
            if (data?.content?.trim()) {
              doc.transact(() => {
                ytext.insert(0, data.content);
              });
              console.log(`Seeded Y.Doc for ${docName} from Firestore documents collection`);
            }
          }
        } catch (err) {
          console.error(`Failed to seed from Firestore for ${docName}:`, err);
        }
      }
    }

    doc.on("update", (update: Uint8Array, origin: unknown) => {
      // Broadcast to connected clients, excluding the sender
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageSync);
      syncProtocol.writeUpdate(encoder, update);
      const message = encoding.toUint8Array(encoder);
      const exclude = origin instanceof WebSocket ? origin : null;
      broadcastToRoom(docName, message, exclude);

      // Schedule persistence
      scheduleSave(docName, doc);
    });

    docs.set(docName, doc);
    docLoading.delete(docName);
    return doc;
  })();

  docLoading.set(docName, promise);
  return promise;
}

function getAwareness(docName: string, doc: Y.Doc): awarenessProtocol.Awareness {
  let awareness = awarenesses.get(docName);
  if (!awareness) {
    awareness = new awarenessProtocol.Awareness(doc);
    awareness.on(
      "update",
      (
        { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown,
      ) => {
        const changedClients = added.concat(updated, removed);
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, messageAwareness);
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(awareness!, changedClients),
        );
        const message = encoding.toUint8Array(encoder);
        // Exclude the sender — origin is the WebSocket that sent the awareness update
        const exclude = origin instanceof WebSocket ? origin : null;
        broadcastToRoom(docName, message, exclude);
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

// Clean up a room when the last client disconnects
async function cleanupRoom(docName: string) {
  const roomConns = conns.get(docName);
  if (roomConns && roomConns.size > 0) return; // still has clients

  // Flush any pending save
  const timer = saveTimers.get(docName);
  if (timer) {
    clearTimeout(timer);
    saveTimers.delete(docName);
  }

  const doc = docs.get(docName);
  if (doc) {
    await saveSnapshot(docName, doc);
    doc.destroy();
    docs.delete(docName);
  }

  awarenesses.delete(docName);
  conns.delete(docName);
  docLoading.delete(docName);
  console.log(`Room ${docName} cleaned up and persisted`);
}

// ─── HTTP + WebSocket Server ────────────────────────────────────

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("MarkFlow y-websocket server");
});

const wss = new WebSocketServer({ server });

wss.on("connection", async (ws, req) => {
  // ── Buffer messages immediately ──────────────────────────
  // Client sends sync step 1 right after connecting (in onopen).
  // If we await async operations (auth, getYDoc) before registering
  // the message handler, the client's step 1 is silently dropped.
  // This causes the server to never send step 2, so the client
  // never receives the server's Y.Doc content → duplication.
  const pendingMessages: ArrayBuffer[] = [];
  let ready = false;
  let closed = false;
  const controlledIds = new Set<number>();

  // Message processing function (used after ready)
  const processMessage = (data: ArrayBuffer, doc: Y.Doc, awareness: awarenessProtocol.Awareness) => {
    try {
      const message = new Uint8Array(data as ArrayBuffer);
      const decoder = decoding.createDecoder(message);
      const messageType = decoding.readVarUint(decoder);

      switch (messageType) {
        case messageSync: {
          const encoder = encoding.createEncoder();
          encoding.writeVarUint(encoder, messageSync);
          // Pass ws as origin so the update handler can exclude the sender
          syncProtocol.readSyncMessage(decoder, encoder, doc, ws);
          if (encoding.length(encoder) > 1) {
            ws.send(encoding.toUint8Array(encoder));
          }
          break;
        }
        case messageAwareness: {
          const update = decoding.readVarUint8Array(decoder);
          // Track which client IDs this connection controls
          const decoder2 = decoding.createDecoder(update);
          const len = decoding.readVarUint(decoder2);
          for (let i = 0; i < len; i++) {
            const clientId = decoding.readVarUint(decoder2);
            controlledIds.add(clientId);
            decoding.readVarUint(decoder2); // skip clock
            decoding.readVarString(decoder2); // skip state JSON
          }
          awarenessProtocol.applyAwarenessUpdate(awareness, update, ws);
          break;
        }
      }
    } catch (err) {
      console.error("Error handling message:", err);
    }
  };

  // Closure variables set after async init completes
  let doc: Y.Doc | null = null;
  let awareness: awarenessProtocol.Awareness | null = null;
  let docName: string | null = null;

  // Register message handler IMMEDIATELY to buffer during async init
  ws.on("message", (data: ArrayBuffer) => {
    if (!ready) {
      pendingMessages.push(data);
      return;
    }
    processMessage(data, doc!, awareness!);
  });

  ws.on("close", () => {
    closed = true;
    if (docName) {
      const roomConns = conns.get(docName);
      if (roomConns) {
        roomConns.delete(ws);
      }
      if (awareness) {
        awarenessProtocol.removeAwarenessStates(awareness, Array.from(controlledIds), null);
      }
      cleanupRoom(docName);
    }
  });

  // ── Async init (auth + doc load) ─────────────────────────
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const token = url.searchParams.get("token");
  docName = url.pathname.slice(1) || "default";

  if (token) {
    try {
      await auth.verifyIdToken(token);
    } catch {
      ws.close(4401, "Invalid auth token");
      return;
    }
  } else {
    ws.close(4401, "Authentication required");
    return;
  }

  if (closed) return; // Client disconnected during auth

  doc = await getYDoc(docName);
  if (closed) return; // Client disconnected during doc load

  awareness = getAwareness(docName, doc);

  if (!conns.has(docName)) {
    conns.set(docName, new Map());
  }
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

  // ── Flush buffered messages ──────────────────────────────
  ready = true;
  for (const msg of pendingMessages) {
    if (closed) break;
    processMessage(msg, doc, awareness);
  }
  pendingMessages.length = 0;
});

server.listen(PORT, HOST, () => {
  console.log(`y-websocket server running on ${HOST}:${PORT}`);
});
