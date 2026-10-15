import { Server, Socket } from 'socket.io';
import CoinGameService from '../application/CoinGameService';
import { CoinItem } from '../domain/modes/CoinModeEngine';
import { getCoinRoom } from '../application/RoomStore';
import ResponseUtil, { ApiResponse } from '../utils/ResponseUtil';

// Every gateway is registered on every socket, so coin mode's events are all
// prefixed `coin:`. An unprefixed name here would also drive simple mode's
// handler for the same socket, and both engines would act on one click.
//
// Room-level events (createRoom, joinRoom, leaveRoom, requestSnapshot and the
// roster broadcasts) stay shared and unprefixed in RoomGateway -- they differ
// between modes only in the shape of the `players` array.

export default (io: Server, socket: Socket) => {

    // Every game action is attributed to the stable playerId bound at join
    // time, never to socket.id -- the socket id rotates on every reconnect.
    const currentPlayerId = (): string | undefined => socket.data.playerId;

    const requireHost = (roomCode: string, callback?: (res: ApiResponse) => void) => {
        const room = getCoinRoom(roomCode);
        if (!room) {
            if (callback) callback(ResponseUtil.notFound({ errorType: 'ROOM_NOT_FOUND' }));
            return undefined;
        }
        if (!currentPlayerId() || room.hostId !== currentPlayerId()) {
            if (callback) callback(ResponseUtil.error({ code: 403, errorType: 'PERMISSION_DENIED' }));
            return undefined;
        }
        return room;
    };

    // ---------------------------------------------------
    // Action: Host tunes the room (§2)
    // ---------------------------------------------------
    // Editable until start, locked during play, and persists across resets so a
    // group tunes once per session rather than once per game.
    socket.on('coin:updateSettings', (
        data: { roomCode?: string; coinTarget?: number; roundLimit?: number; laserStartRound?: number | null },
        callback?: (res: ApiResponse) => void,
    ) => {
        if (!data.roomCode) {
            if (callback) callback(ResponseUtil.badRequest({ message: 'Missing room code' }));
            return;
        }

        const roomCode = data.roomCode.toUpperCase();
        if (!requireHost(roomCode, callback)) return;

        const result = CoinGameService.handleUpdateSettings(roomCode, {
            coinTarget: data.coinTarget,
            roundLimit: data.roundLimit,
            laserStartRound: data.laserStartRound,
        });

        if (!result.success || !result.data) {
            switch (result.error) {
                case 'ROOM_NOT_FOUND':
                    if (callback) callback(ResponseUtil.notFound({ errorType: 'ROOM_NOT_FOUND' }));
                    break;
                case 'WRONG_PHASE':
                    if (callback) callback(ResponseUtil.error({ code: 403, errorType: 'WRONG_PHASE', data: 'Settings lock when the game starts' }));
                    break;
                case 'INVALID_SETTING':
                    if (callback) callback(ResponseUtil.error({ code: 400, errorType: 'INVALID_SETTING' }));
                    break;
                default:
                    if (callback) callback(ResponseUtil.error({ code: 500, errorType: 'UNKNOWN_ERROR' }));
            }
            return;
        }

        if (callback) callback(ResponseUtil.success({ data: { settings: result.data } }));

        io.to(roomCode).emit('coin:gameSettingsChanged', ResponseUtil.success({
            data: { settings: result.data },
        }));
    });

    // ---------------------------------------------------
    // Action: Player picks a hidden tile in the lobby (§4)
    // ---------------------------------------------------
    // Re-pickable until the host starts. Others are told only that this player
    // has a pick -- never which tile, not even in the lobby.
    socket.on('coin:setPosition', (
        data: { roomCode?: string; x?: number; y?: number },
        callback?: (res: ApiResponse) => void,
    ) => {
        if (!data.roomCode || data.x === undefined || data.y === undefined) {
            if (callback) callback(ResponseUtil.badRequest({ message: 'Missing room code or x, y position' }));
            return;
        }

        const playerId = currentPlayerId();
        if (!playerId) {
            if (callback) callback(ResponseUtil.error({ code: 403, errorType: 'PLAYER_NOT_FOUND', data: 'You are not in a room' }));
            return;
        }

        const roomCode = data.roomCode.toUpperCase();
        const result = CoinGameService.handleSetPosition(roomCode, playerId, data.x, data.y);

        if (!result.success) {
            switch (result.error) {
                case 'ROOM_NOT_FOUND':
                    if (callback) callback(ResponseUtil.notFound({ errorType: 'ROOM_NOT_FOUND' }));
                    break;
                case 'WRONG_PHASE':
                    if (callback) callback(ResponseUtil.error({ code: 403, errorType: 'WRONG_PHASE', data: 'Positions are picked in the lobby' }));
                    break;
                case 'PLAYER_NOT_FOUND':
                    if (callback) callback(ResponseUtil.error({ code: 403, errorType: 'PLAYER_NOT_FOUND' }));
                    break;
                case 'INVALID_COORDINATES':
                    if (callback) callback(ResponseUtil.error({ code: 400, errorType: 'INVALID_COORDINATES' }));
                    break;
                case 'TILE_ALREADY_DESTROYED':
                    if (callback) callback(ResponseUtil.error({ code: 403, errorType: 'TILE_ALREADY_DESTROYED' }));
                    break;
                default:
                    if (callback) callback(ResponseUtil.error({ code: 500, errorType: 'UNKNOWN_ERROR' }));
            }
            return;
        }

        if (callback) callback(ResponseUtil.success());

        socket.to(roomCode).emit('coin:playerReady', ResponseUtil.success({ data: { playerId } }));
    });

    // ---------------------------------------------------
    // Action: Host starts the game (§4)
    // ---------------------------------------------------
    // Round 1 begins directly at the action phase -- everyone is already
    // positioned, so there is no separate position phase.
    socket.on('coin:startGame', (
        data: { roomCode?: string; force?: boolean },
        callback?: (res: ApiResponse) => void,
    ) => {
        if (!data.roomCode) {
            if (callback) callback(ResponseUtil.badRequest({ message: 'Missing room code' }));
            return;
        }

        const roomCode = data.roomCode.toUpperCase();
        if (!requireHost(roomCode, callback)) return;

        const result = CoinGameService.handleStartGame(roomCode, data.force === true);

        if (!result.success || !result.data) {
            switch (result.error) {
                case 'ROOM_NOT_FOUND':
                    if (callback) callback(ResponseUtil.notFound({ errorType: 'ROOM_NOT_FOUND' }));
                    break;
                case 'WRONG_PHASE':
                    if (callback) callback(ResponseUtil.error({ code: 403, errorType: 'WRONG_PHASE', data: 'The game is already running' }));
                    break;
                case 'NOT_ENOUGH_PLAYERS':
                    if (callback) callback(ResponseUtil.error({ code: 400, errorType: 'NOT_ENOUGH_PLAYERS', data: 'Need at least 2 players to start the game' }));
                    break;
                case 'PLAYERS_NOT_READY':
                    if (callback) callback(ResponseUtil.error({ code: 409, errorType: 'PLAYERS_NOT_READY', data: 'Someone has not picked a tile yet' }));
                    break;
                default:
                    if (callback) callback(ResponseUtil.error({ code: 500, errorType: 'UNKNOWN_ERROR' }));
            }
            return;
        }

        if (callback) callback(ResponseUtil.success());

        io.to(roomCode).emit('coin:gameStarted', ResponseUtil.success({ data: result.data }));
    });

    // ---------------------------------------------------
    // Action: Living player moves or collects (§5.1)
    // ---------------------------------------------------
    socket.on('coin:chooseAction', (
        data: { roomCode?: string; action?: 'move' | 'collect'; target?: { x: number; y: number } },
        callback?: (res: ApiResponse) => void,
    ) => {
        if (!data.roomCode || !data.action) {
            if (callback) callback(ResponseUtil.badRequest({ message: 'Missing room code or action' }));
            return;
        }
        if (data.action !== 'move' && data.action !== 'collect') {
            if (callback) callback(ResponseUtil.badRequest({ message: 'Unknown action' }));
            return;
        }

        const playerId = currentPlayerId();
        if (!playerId) {
            if (callback) callback(ResponseUtil.error({ code: 403, errorType: 'PLAYER_NOT_FOUND', data: 'You are not in a room' }));
            return;
        }

        const roomCode = data.roomCode.toUpperCase();
        const result = CoinGameService.handleChooseAction(roomCode, playerId, data.action, data.target);

        if (!result.success) {
            switch (result.error) {
                case 'ROOM_NOT_FOUND':
                    if (callback) callback(ResponseUtil.notFound({ errorType: 'ROOM_NOT_FOUND' }));
                    break;
                case 'WRONG_PHASE':
                    if (callback) callback(ResponseUtil.error({ code: 403, errorType: 'WRONG_PHASE', data: 'Not in the action phase' }));
                    break;
                case 'DEAD_PLAYER':
                    if (callback) callback(ResponseUtil.error({ code: 403, errorType: 'DEAD_PLAYER', data: 'Dead players do nothing in the action phase' }));
                    break;
                case 'ACTION_ALREADY_LOCKED':
                    if (callback) callback(ResponseUtil.error({ code: 409, errorType: 'ACTION_ALREADY_LOCKED', data: 'Your action is locked in for this round' }));
                    break;
                case 'MISSING_TARGET':
                    if (callback) callback(ResponseUtil.badRequest({ errorType: 'MISSING_TARGET', message: 'A move needs a target tile' }));
                    break;
                case 'TILE_NOT_ADJACENT':
                    if (callback) callback(ResponseUtil.error({ code: 403, errorType: 'TILE_NOT_ADJACENT', data: 'A move goes one tile, any direction' }));
                    break;
                case 'NOT_A_MOVE':
                    if (callback) callback(ResponseUtil.error({ code: 400, errorType: 'NOT_A_MOVE', data: 'Staying put is what Collect is for' }));
                    break;
                case 'TILE_ALREADY_DESTROYED':
                    if (callback) callback(ResponseUtil.error({ code: 403, errorType: 'TILE_ALREADY_DESTROYED' }));
                    break;
                case 'INVALID_COORDINATES':
                    if (callback) callback(ResponseUtil.error({ code: 400, errorType: 'INVALID_COORDINATES' }));
                    break;
                default:
                    if (callback) callback(ResponseUtil.error({ code: 500, errorType: 'UNKNOWN_ERROR' }));
            }
            return;
        }

        if (callback) callback(ResponseUtil.success());

        // A lock-in marker only. What was chosen, and where, stays private --
        // a move that announced its destination would defeat the point.
        socket.to(roomCode).emit('coin:actionLocked', ResponseUtil.success({ data: { playerId } }));
    });

    // ---------------------------------------------------
    // Action: Living player throws (§7.1)
    // ---------------------------------------------------
    socket.on('coin:throwBomb', (
        data: { roomCode?: string; targets?: { x: number; y: number }[] },
        callback?: (res: ApiResponse) => void,
    ) => {
        if (!data.roomCode || !Array.isArray(data.targets) || data.targets.length === 0) {
            if (callback) callback(ResponseUtil.badRequest({ message: 'Missing room code or targets' }));
            return;
        }

        const playerId = currentPlayerId();
        if (!playerId) {
            if (callback) callback(ResponseUtil.error({ code: 403, errorType: 'PLAYER_NOT_FOUND', data: 'You are not in a room' }));
            return;
        }

        const roomCode = data.roomCode.toUpperCase();
        const result = CoinGameService.handleThrowBomb(roomCode, playerId, data.targets);

        if (!result.success || !result.data) {
            switch (result.error) {
                case 'ROOM_NOT_FOUND':
                    if (callback) callback(ResponseUtil.notFound({ errorType: 'ROOM_NOT_FOUND' }));
                    break;
                case 'WRONG_PHASE':
                    if (callback) callback(ResponseUtil.error({ code: 403, errorType: 'WRONG_PHASE', data: 'Not in the attack phase' }));
                    break;
                case 'DEAD_PLAYER':
                    if (callback) callback(ResponseUtil.error({ code: 403, errorType: 'DEAD_PLAYER', data: 'Dead players hack, they do not throw' }));
                    break;
                case 'BOMB_ALREADY_THROWN':
                    if (callback) callback(ResponseUtil.error({ code: 409, errorType: 'BOMB_ALREADY_THROWN', data: 'You have already locked in this round' }));
                    break;
                case 'WRONG_TARGET_COUNT':
                    if (callback) callback(ResponseUtil.error({ code: 400, errorType: 'WRONG_TARGET_COUNT' }));
                    break;
                case 'DUPLICATE_TARGET':
                    if (callback) callback(ResponseUtil.error({ code: 400, errorType: 'DUPLICATE_TARGET', data: 'A Triple Bomb needs three distinct tiles' }));
                    break;
                case 'TILE_ALREADY_DESTROYED':
                    if (callback) callback(ResponseUtil.error({ code: 403, errorType: 'TILE_ALREADY_DESTROYED', data: 'Cannot bomb a destroyed tile' }));
                    break;
                case 'INVALID_COORDINATES':
                    if (callback) callback(ResponseUtil.error({ code: 400, errorType: 'INVALID_COORDINATES' }));
                    break;
                default:
                    if (callback) callback(ResponseUtil.error({ code: 500, errorType: 'UNKNOWN_ERROR' }));
            }
            return;
        }

        if (callback) callback(ResponseUtil.success({ data: { resolveOrder: result.data.resolveOrder } }));

        // The order is public, as simple mode's throwOrder is: it says when you
        // committed, never to what.
        socket.to(roomCode).emit('coin:attackLocked', ResponseUtil.success({
            data: { playerId, resolveOrder: result.data.resolveOrder },
        }));
    });

    // ---------------------------------------------------
    // Action: Dead player hacks (§7.2)
    // ---------------------------------------------------
    // Names several tiles and steals from every living player standing on each.
    // Duplicates are legal and pay each time, so the targets are deliberately
    // not de-duplicated here.
    socket.on('coin:hack', (
        data: { roomCode?: string; targets?: { x: number; y: number }[] },
        callback?: (res: ApiResponse) => void,
    ) => {
        if (!data.roomCode || !Array.isArray(data.targets) || data.targets.length === 0) {
            if (callback) callback(ResponseUtil.badRequest({ message: 'Missing room code or targets' }));
            return;
        }

        const playerId = currentPlayerId();
        if (!playerId) {
            if (callback) callback(ResponseUtil.error({ code: 403, errorType: 'PLAYER_NOT_FOUND', data: 'You are not in a room' }));
            return;
        }

        const roomCode = data.roomCode.toUpperCase();
        const result = CoinGameService.handleHack(roomCode, playerId, data.targets);

        if (!result.success || !result.data) {
            switch (result.error) {
                case 'ROOM_NOT_FOUND':
                    if (callback) callback(ResponseUtil.notFound({ errorType: 'ROOM_NOT_FOUND' }));
                    break;
                case 'WRONG_PHASE':
                    if (callback) callback(ResponseUtil.error({ code: 403, errorType: 'WRONG_PHASE', data: 'Not in the attack phase' }));
                    break;
                case 'LIVING_PLAYER':
                    if (callback) callback(ResponseUtil.error({ code: 403, errorType: 'LIVING_PLAYER', data: 'Living players throw bombs, they do not hack' }));
                    break;
                case 'HACK_ALREADY_LOCKED':
                    if (callback) callback(ResponseUtil.error({ code: 409, errorType: 'HACK_ALREADY_LOCKED', data: 'You have already locked in this round' }));
                    break;
                case 'WRONG_TARGET_COUNT':
                    if (callback) callback(ResponseUtil.error({ code: 400, errorType: 'WRONG_TARGET_COUNT' }));
                    break;
                case 'TILE_ALREADY_DESTROYED':
                    if (callback) callback(ResponseUtil.error({ code: 403, errorType: 'TILE_ALREADY_DESTROYED', data: 'Cannot hack a destroyed tile' }));
                    break;
                case 'INVALID_COORDINATES':
                    if (callback) callback(ResponseUtil.error({ code: 400, errorType: 'INVALID_COORDINATES' }));
                    break;
                default:
                    if (callback) callback(ResponseUtil.error({ code: 500, errorType: 'UNKNOWN_ERROR' }));
            }
            return;
        }

        if (callback) callback(ResponseUtil.success({ data: { resolveOrder: result.data.resolveOrder } }));

        // Dead players lock in alongside the living, so the room sees the same
        // marker either way -- when they committed, never to what.
        socket.to(roomCode).emit('coin:attackLocked', ResponseUtil.success({
            data: { playerId, resolveOrder: result.data.resolveOrder },
        }));
    });

    // ---------------------------------------------------
    // Action: Buy an item (§8)
    // ---------------------------------------------------
    socket.on('coin:buyItem', (
        data: { roomCode?: string; item?: string },
        callback?: (res: ApiResponse) => void,
    ) => {
        if (!data.roomCode || !data.item) {
            if (callback) callback(ResponseUtil.badRequest({ message: 'Missing room code or item' }));
            return;
        }

        const playerId = currentPlayerId();
        if (!playerId) {
            if (callback) callback(ResponseUtil.error({ code: 403, errorType: 'PLAYER_NOT_FOUND', data: 'You are not in a room' }));
            return;
        }

        const roomCode = data.roomCode.toUpperCase();
        const result = CoinGameService.handleBuyItem(roomCode, playerId, data.item as CoinItem);

        if (!result.success || !result.data) {
            switch (result.error) {
                case 'ROOM_NOT_FOUND':
                    if (callback) callback(ResponseUtil.notFound({ errorType: 'ROOM_NOT_FOUND' }));
                    break;
                case 'WRONG_PHASE':
                    if (callback) callback(ResponseUtil.error({ code: 403, errorType: 'WRONG_PHASE', data: 'An item is bought in the phase it acts in' }));
                    break;
                case 'WRONG_LIFE_STATUS':
                    if (callback) callback(ResponseUtil.error({ code: 403, errorType: 'WRONG_LIFE_STATUS', data: 'That shop is not yours' }));
                    break;
                case 'ALREADY_OWNED':
                    if (callback) callback(ResponseUtil.error({ code: 409, errorType: 'ALREADY_OWNED' }));
                    break;
                case 'ALREADY_LOCKED':
                    if (callback) callback(ResponseUtil.error({ code: 409, errorType: 'ALREADY_LOCKED', data: 'Too late -- you have already locked in' }));
                    break;
                case 'NOT_AFFORDABLE':
                    if (callback) callback(ResponseUtil.error({ code: 403, errorType: 'NOT_AFFORDABLE', data: 'Not enough coins' }));
                    break;
                case 'UNKNOWN_ITEM':
                    if (callback) callback(ResponseUtil.error({ code: 400, errorType: 'UNKNOWN_ITEM' }));
                    break;
                default:
                    if (callback) callback(ResponseUtil.error({ code: 500, errorType: 'UNKNOWN_ERROR' }));
            }
            return;
        }

        // Private: what you own and what it left you is nobody else's business
        // until the wallets refresh at the end of the round.
        if (callback) callback(ResponseUtil.success({ data: { item: data.item, wallet: result.data.wallet } }));
    });

    // ---------------------------------------------------
    // Action: Host resets the game back to lobby
    // ---------------------------------------------------
    socket.on('coin:resetGame', (data: { roomCode?: string }, callback?: (res: ApiResponse) => void) => {
        if (!data.roomCode) {
            if (callback) callback(ResponseUtil.badRequest({ message: 'Missing room code' }));
            return;
        }

        const roomCode = data.roomCode.toUpperCase();
        if (!requireHost(roomCode, callback)) return;

        const result = CoinGameService.handleResetGame(roomCode);

        if (!result.success || !result.data) {
            switch (result.error) {
                case 'ROOM_NOT_FOUND':
                    if (callback) callback(ResponseUtil.notFound({ errorType: 'ROOM_NOT_FOUND' }));
                    break;
                case 'WRONG_PHASE':
                    if (callback) callback(ResponseUtil.error({ code: 403, errorType: 'WRONG_PHASE' }));
                    break;
                default:
                    if (callback) callback(ResponseUtil.error({ code: 500, errorType: 'UNKNOWN_ERROR' }));
            }
            return;
        }

        if (callback) callback(ResponseUtil.success());

        io.to(roomCode).emit('coin:gameReset', ResponseUtil.success({
            data: {
                // Fresh, fully alive roster on re-rolled piles: still-disconnected
                // players pruned, last game's spectators promoted in.
                players: result.data.players,
                spectators: result.data.spectators,
                newHostId: result.data.hostId,
                piles: result.data.piles,
                settings: result.data.settings,
            },
        }));
    });
};
