import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server } from 'socket.io';

@WebSocketGateway({ cors: { origin: '*' } })
export class NotificationGateway {
  @WebSocketServer()
  server: Server;

  sendTopupSuccess(userId: string, data: { amount: number; balance: number }) {
    this.server.to(userId).emit('topup_success', data);
  }

  handleConnection(client: any) {
    const userId = client.handshake.query.userId as string;
    if (userId) {
      client.join(userId);
    }
  }
}
