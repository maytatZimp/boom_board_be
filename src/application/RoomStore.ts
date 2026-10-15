import CoinModeEngine from '../domain/modes/CoinModeEngine';
import { RoomEngine } from '../domain/modes/RoomEngine';
import SimpleModeEngine from '../domain/modes/SimpleModeEngine';

export type GameMode = 'simple' | 'coin';

export interface Room {
    code: string;
    hostId: string;
    // Typed as the room-layer contract, not as a concrete engine: RoomService
    // and RoomGateway are mode-agnostic and must stay that way. A mode's own
    // service narrows this back with getSimpleRoom/getCoinRoom below before
    // touching anything about a round.
    game: RoomEngine;
    gameMode: GameMode;
    phaseTimer: NodeJS.Timeout | null;
    processTimer: NodeJS.Timeout | null;
    // Wall-clock deadline of the currently running phase timer, or null when no
    // timed phase is active. Only used to tell a (re)joining client how much of
    // the phase is left, since it arrives mid-countdown.
    phaseEndsAt: number | null;
}

// `Omit` rather than `&`: intersecting would leave `game` as
// `RoomEngine & SimpleModeEngine`, whose `players` is an unusable intersection
// of two array types. A mode's service wants the concrete engine, nothing less.
export type SimpleRoom = Omit<Room, 'game'> & { game: SimpleModeEngine };
export type CoinRoom = Omit<Room, 'game'> & { game: CoinModeEngine };

// What a live socket is currently bound to. Kept keyed by socket id because
// that is all the `disconnect` handler gets, but it resolves to the stable
// `playerId` that everything else in the system keys on.
export interface SocketBinding {
    roomCode: string;
    playerId: string;
}

// 🏆 THE SINGLE SOURCE OF TRUTH
export const activeRooms: Record<string, Room> = {};
export const socketTracker: Record<string, SocketBinding> = {};
// Reverse lookup, playerId -> socket id. Used to evict the previous socket when
// the same identity reconnects (newest wins).
export const playerSocketTracker: Record<string, string> = {};

// Mode-narrowing lookups. A mode's service and gateway go through these rather
// than indexing `activeRooms` directly, so handing simple mode's round logic a
// coin room is a miss rather than a crash -- which matters because every
// gateway is registered on every socket.
export function getSimpleRoom(roomCode: string): SimpleRoom | undefined {
    const room = activeRooms[roomCode];
    if (!room || room.gameMode !== 'simple') return undefined;
    return room as SimpleRoom;
}

export function getCoinRoom(roomCode: string): CoinRoom | undefined {
    const room = activeRooms[roomCode];
    if (!room || room.gameMode !== 'coin') return undefined;
    return room as CoinRoom;
}
