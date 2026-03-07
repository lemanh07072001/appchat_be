import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';

@WebSocketGateway({ cors: { origin: '*' } })
export class NotificationGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(NotificationGateway.name);

  @WebSocketServer()
  server: Server;

  handleConnection(client: Socket) {
    const userId = client.handshake.query.userId as string;
    this.logger.log(`Socket connected — id: ${client.id} | userId: ${userId ?? 'none'}`);
    if (userId) {
      client.join(userId);
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Socket disconnected — id: ${client.id}`);
  }

  sendTopupSuccess(userId: string, data: { amount: number; balance: number }) {
    const room = this.server.sockets.adapter.rooms.get(userId);
    const clientCount = room?.size ?? 0;
    this.logger.log(`Emit topup_success → userId: ${userId} | clients: ${clientCount} | amount: ${data.amount} | balance: ${data.balance}`);
    this.server.to(userId).emit('topup_success', data);
  }
}
