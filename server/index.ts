import { WebSocketServer } from "ws";
import http from "http";
import { setupWSConnection } from "y-websocket/bin/utils";

const PORT = parseInt(process.env.PORT || "1234", 10);
const HOST = process.env.HOST || "0.0.0.0";

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("MarkFlow y-websocket server");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  setupWSConnection(ws, req);
});

server.listen(PORT, HOST, () => {
  console.log(`y-websocket server running on ${HOST}:${PORT}`);
});
