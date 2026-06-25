import { WebSocketServer, WebSocket } from "ws";
import * as http from "http";
import * as crypto from "crypto";
import {
  ProtocolHandler,
  WSClient,
  ProtocolFrame,
} from "./ws-protocol";

export class WSServerTransport {
  private wss: WebSocketServer | null = null;
  private protocolHandler: ProtocolHandler;
  private wsToClientId = new Map<WebSocket, string>();

  constructor(
    protocolHandler: ProtocolHandler,
    private eventBus: { publish(event: string, data: unknown, source: string): Promise<void> }
  ) {
    this.protocolHandler = protocolHandler;
  }

  attach(httpServer: http.Server): void {
    this.wss = new WebSocketServer({ server: httpServer, path: "/ws" });

    this.wss.on("connection", (ws, req) => {
      const clientId = crypto.randomUUID();
      const remoteAddress = req.socket.remoteAddress ?? "unknown";

      const client: WSClient = {
        id: clientId,
        role: "client",
        connectedAt: new Date(),
        send(frame: ProtocolFrame): void {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(frame));
          }
        },
        close(code?: number, reason?: string): void {
          ws.close(code ?? 1000, reason ?? "");
        },
        isConnected(): boolean {
          return ws.readyState === WebSocket.OPEN;
        },
        remoteAddress(): string {
          return remoteAddress;
        },
      };

      this.wsToClientId.set(ws, clientId);
      this.protocolHandler.handleConnection(client);

      ws.on("message", (data: Buffer, isBinary: boolean) => {
        if (isBinary) {
          ws.close(4005, "Binary frames not supported");
          return;
        }
        const raw = data.toString("utf8");
        this.protocolHandler.processFrame(client, raw).catch((err) => {
          process.stderr.write(`[WSServerTransport] Error processing frame from ${clientId}:` + " " + err);
        });
      });

      ws.on("close", (code: number, reason: Buffer) => {
        this.wsToClientId.delete(ws);
        this.protocolHandler.handleDisconnect(clientId);
        process.stdout.write(`[WSServerTransport] Client ${clientId} disconnected (code=${code})`);
      });

      ws.on("error", (err: Error) => {
        process.stderr.write(`[WSServerTransport] WebSocket error for ${clientId}:` + " " + err.message);
        this.wsToClientId.delete(ws);
        this.protocolHandler.handleDisconnect(clientId);
      });

      const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
        } else {
          clearInterval(pingInterval);
        }
      }, 30000);
      pingInterval.unref?.();

      ws.on("close", () => {
        clearInterval(pingInterval);
      });

      process.stdout.write(`[WSServerTransport] New WebSocket connection: ${clientId} from ${remoteAddress}`);
    });

    process.stdout.write("[WSServerTransport] WebSocket server attached at /ws");
  }

  detach(): void {
    if (this.wss) {
      for (const ws of this.wss.clients) {
        ws.close(1001, "Server shutting down");
      }
      this.wss.close();
      this.wss = null;
    }
    this.wsToClientId.clear();
  }

  getConnectedCount(): number {
    return this.wss?.clients.size ?? 0;
  }
}
