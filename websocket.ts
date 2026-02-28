import { WebSocketServer, WebSocket } from 'ws';

export interface WebSocketMessage {
  type: string;
  data: any;
  timestamp: string;
}

export class WebSocketManager {
  private wss: WebSocketServer;
  private clients: Set<WebSocket> = new Set();

  constructor(wss: WebSocketServer) {
    this.wss = wss;
    this.setupWebSocketServer();
  }

  private setupWebSocketServer() {
    this.wss.on('connection', (ws: WebSocket, req) => {
      console.log('📡 New WebSocket connection');
      this.clients.add(ws);

      // Send welcome message
      this.sendToClient(ws, 'connected', {
        message: 'Connected to livestream server',
        clientId: this.generateClientId()
      });

      // Handle messages from client
      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleClientMessage(ws, message);
        } catch (error) {
          console.error('Invalid WebSocket message:', error);
        }
      });

      // Handle client disconnect
      ws.on('close', () => {
        console.log('📡 WebSocket connection closed');
        this.clients.delete(ws);
      });

      // Handle errors
      ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        this.clients.delete(ws);
      });
    });
  }

  private handleClientMessage(ws: WebSocket, message: any) {
    switch (message.type) {
      case 'ping':
        this.sendToClient(ws, 'pong', { timestamp: new Date().toISOString() });
        break;
      
      case 'subscribe_stream':
        // In a real implementation, you'd track which streams clients are subscribed to
        console.log(`Client subscribed to stream: ${message.streamId}`);
        break;
      
      case 'unsubscribe_stream':
        console.log(`Client unsubscribed from stream: ${message.streamId}`);
        break;
      
      default:
        console.log('Unknown message type:', message.type);
    }
  }

  private generateClientId(): string {
    return Math.random().toString(36).substr(2, 9);
  }

  sendToClient(ws: WebSocket, type: string, data: any) {
    if (ws.readyState === WebSocket.OPEN) {
      const message: WebSocketMessage = {
        type,
        data,
        timestamp: new Date().toISOString()
      };
      
      ws.send(JSON.stringify(message));
    }
  }

  broadcast(type: string, data: any) {
    const message: WebSocketMessage = {
      type,
      data,
      timestamp: new Date().toISOString()
    };

    const messageStr = JSON.stringify(message);
    
    this.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(messageStr);
      }
    });

    console.log(`📡 Broadcasted ${type} to ${this.clients.size} clients`);
  }

  getConnectedClientsCount(): number {
    return this.clients.size;
  }

  cleanup() {
    this.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.close();
      }
    });
    this.clients.clear();
  }
}