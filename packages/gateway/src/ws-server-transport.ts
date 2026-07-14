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
    // maxPayload: 1MB 足够所有合法协议帧，防止大帧耗尽内存
    this.wss = new WebSocketServer({ server: httpServer, path: "/ws", maxPayload: 1024 * 1024 });

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
          process.stderr.write(`[WSServerTransport] Error processing frame from ${clientId}:` + " " + err + "\n");
        });
      });

      // 心跳 + pong 超时检测：未响应 ping 的死连接会被 terminate
      let isAlive = true;
      ws.on("pong", () => { isAlive = true; });
      const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          if (!isAlive) {
            ws.terminate();
            return;
          }
          isAlive = false;
          ws.ping();
        } else {
          clearInterval(pingInterval);
        }
      }, 30000);
      pingInterval.unref?.();

      // 合并为单个 close 监听器：同时清理 wsToClientId、handleDisconnect 和 pingInterval
      ws.on("close", (code: number, reason: Buffer) => {
        clearInterval(pingInterval);
        this.wsToClientId.delete(ws);
        this.protocolHandler.handleDisconnect(clientId);
        process.stdout.write(`[WSServerTransport] Client ${clientId} disconnected (code=${code})\n`);
      });

      // error 事件也需清理 pingInterval 和连接状态，避免泄漏
      ws.on("error", (err: Error) => {
        process.stderr.write(`[WSServerTransport] WebSocket error for ${clientId}:` + " " + err.message + "\n");
        clearInterval(pingInterval);
        this.wsToClientId.delete(ws);
        this.protocolHandler.handleDisconnect(clientId);
      });

      process.stdout.write(`[WSServerTransport] New WebSocket connection: ${clientId} from ${remoteAddress}\n`);
    });

    process.stdout.write("[WSServerTransport] WebSocket server attached at /ws\n");
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
