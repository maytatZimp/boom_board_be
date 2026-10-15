import { Server as HttpServer } from 'http';
import { Server as SocketIOServer, Socket } from 'socket.io';
import registerRoomHandlers from './RoomGateway';
import registerGameHandlers from './GameGateway';
import registerCoinGameHandlers from './CoinGameGateway';
import GameService from '../application/GameService';
import CoinGameService from '../application/CoinGameService';
import logger from '../utils/Logger';

export default (server: HttpServer) => {
    // Initialize Socket.IO with our HTTP server
    const io = new SocketIOServer(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

    io.on('connection', (socket: Socket) => {
        logger.debug(`Player connected: ${socket.id}`);

        // Pass the typed io and socket instances to our handlers
        registerRoomHandlers(io, socket);
        // Both game gateways bind to every socket. They never collide because
        // coin mode's events are all prefixed `coin:`, and each one narrows the
        // room to its own mode before acting.
        registerGameHandlers(io, socket);
        registerCoinGameHandlers(io, socket);
    });

    GameService.init(io);
    CoinGameService.init(io);
};