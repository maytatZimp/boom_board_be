import Board from '../models/Board';
import SpectatorEntity from '../models/SpectatorEntity';

// The slice of a game engine that the room layer -- RoomService, RoomGateway --
// is allowed to touch. It is a type contract, not a base class: each mode owns
// its own engine outright, and nothing here carries an implementation that one
// mode could change out from under another.
//
// Everything about a round (phases, resolution, scoring) is deliberately absent.
// A mode's own service narrows `Room.game` back to its concrete engine via
// `getSimpleRoom` / `getCoinRoom` before reaching for any of that.

// The transport shape of a history-log entry. Each mode keeps its own union of
// `type` values; the room layer only forwards whole entries.
export interface RoomActionLog {
    id: string;
    type: string;
    timestamp: number;
    data: any;
}

// A roster member -- a player or a spectator. `secret` is the private
// credential and must never reach a broadcast payload.
export interface RosterMember {
    id: string;
    name: string;
    secret: string;
    setName(name: string): void;
}

export interface RosterPlayer extends RosterMember {
    isAlive: boolean;
    isDisconnected: boolean;
    setDisconnected(flag: boolean): void;
}

export interface RoomEngine {
    // Mode-specific union of phase names. The room layer only ever compares it
    // against 'lobby', which every mode has.
    state: string;
    board: Board;
    players: RosterPlayer[];
    spectators: SpectatorEntity[];

    // Each mode mints its own player type, so the room layer asks for a player
    // rather than constructing one.
    addNewPlayer(id: string, name: string, secret: string): boolean;

    addSpectator(spectator: SpectatorEntity): boolean;
    removeSpectator(spectatorId: string): boolean;

    // Public roster shapes differ per mode (coin mode's carries a wallet). The
    // room layer forwards them untouched, so the element type is open.
    getPlayersList(): object[];
    getSpectatorsList(): object[];

    // The one log entry the room layer writes itself. Modes name the entry
    // whatever their own log union calls it.
    logPlayerDisconnected(playerId: string, playerName: string): RoomActionLog;
}
