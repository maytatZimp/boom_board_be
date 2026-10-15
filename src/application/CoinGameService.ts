import {
    CoinActionLog,
    CoinEndReason,
    CoinGameState,
    CoinPlayerModel,
    CoinRankingModel,
    CoinSpectatorModel,
    BuyItemErrorType,
    CoinItem,
    SetActionErrorType,
    SetBombErrorType,
    SetHackErrorType,
    SetPositionErrorType,
    StartGameErrorType,
    UpdateSettingsErrorType,
} from '../domain/modes/CoinModeEngine';
import { CoinActionType } from '../domain/models/CoinPlayerEntity';
import { Coordinate } from '../domain/modes/coin/BoardGeometry';
import {
    ACTION_PHASE_SECONDS,
    ATTACK_PHASE_SECONDS,
    COIN_DIALS,
    CoinDials,
    CoinModeSettings,
    LASER_ANIM_MS,
    ROUND_ANIM_BUFFER_MS,
    bombStepMs,
} from '../domain/modes/coin/constants';
import { CoinRoom, getCoinRoom } from './RoomStore';
import ResponseUtil from '../utils/ResponseUtil';
import { Server } from 'socket.io';

export type CoinActionErrorType =
    | 'ROOM_NOT_FOUND'
    | SetPositionErrorType
    | SetActionErrorType
    | SetBombErrorType
    | SetHackErrorType
    | BuyItemErrorType
    | UpdateSettingsErrorType
    | StartGameErrorType;

export type CoinResetGameErrorType = 'ROOM_NOT_FOUND' | 'WRONG_PHASE';

export interface CoinGameResult<TData = any, TError = string> {
    success: boolean;
    data?: TData;
    error?: TError | 'UNKNOWN_ERROR';
}

export interface CoinStartGameResultData {
    boardSize: { width: number; height: number };
    state: CoinGameState;
    piles: Coordinate[];
    settings: CoinModeSettings;
    destroyedTiles: Coordinate[];
    doomedRing: Coordinate[] | null;
    timeLimit: number;
    roundNumber: number;
    players: CoinPlayerModel[];
    dials: CoinDials;
}

export interface CoinResetGameResultData {
    players: CoinPlayerModel[];
    spectators: CoinSpectatorModel[];
    hostId: string;
    piles: Coordinate[];
    settings: CoinModeSettings;
}

// Everything a client needs to render the room it just walked into, whether it
// is resuming a seat it already had or watching as a spectator.
//
// Coin mode's mid-round state is much larger than simple mode's -- items, a
// pending action, piles, the doomed ring, and two different views of a wallet.
// A snapshot that drops one of those produces a client that is subtly wrong
// rather than visibly broken, so every piece of per-player state belongs here.
export interface CoinRoomSnapshot {
    state: CoinGameState;
    roundNumber: number;
    boardSize: { width: number; height: number };
    destroyedTiles: Coordinate[];
    piles: Coordinate[];
    burnedPiles: Coordinate[];
    doomedRing: Coordinate[] | null;
    settings: CoinModeSettings;
    dials: CoinDials;
    timeLimit: number;
    remainingMs: number;
    players: CoinPlayerModel[];
    spectators: CoinSpectatorModel[];
    logs: CoinActionLog[];
    isSpectator: boolean;
    hostId: string;
    you?: CoinSelfView;
    ranking?: CoinRankingModel[];
    finalPositions?: { playerId: string; x: number; y: number }[];
}

// The private view of your own seat. `wallet` here is the live one -- you are
// the only person entitled to it before the round ends.
export interface CoinSelfView {
    x: number | null;
    y: number | null;
    hasPositioned: boolean;
    isAlive: boolean;
    isDisconnected: boolean;
    wallet: number;
    hasShield: boolean;
    teleporterArmed: boolean;
    bombUpgrade: 'triple' | 'big' | null;
    hasSuperHack: boolean;
    hasDoubleHack: boolean;
    boughtThisRound: boolean;
    pendingAction: { type: CoinActionType; target?: Coordinate } | null;
    bombTargets: Coordinate[] | null;
    hackTargets: Coordinate[] | null;
    resolveOrder: number | null;
}

class CoinGameService {
    private static io: Server;

    static init(ioServer: Server) {
        this.io = ioServer;
    }

    // ==========================================
    // SERVER-INITIATED ACTIONS (The Timers)
    // ==========================================

    // The phase timer is always running and is the sole driver when nobody is
    // connected -- there is no paused state to resume from, so a reconnecting
    // client just picks up mid-countdown via `remainingMs`.
    //
    // Unlike simple mode, the length is per phase: 15s to act, 30s to attack.
    private static startPhaseTimer(room: CoinRoom, seconds: number, onExpiry: () => void) {
        if (room.phaseTimer) clearTimeout(room.phaseTimer);
        room.phaseEndsAt = Date.now() + seconds * 1000;
        room.phaseTimer = setTimeout(onExpiry, seconds * 1000);
    }

    private static clearPhaseTimer(room: CoinRoom) {
        if (room.phaseTimer) clearTimeout(room.phaseTimer);
        room.phaseTimer = null;
        room.phaseEndsAt = null;
    }

    private static armActionPhase(room: CoinRoom) {
        room.game.state = 'action';
        this.startPhaseTimer(room, ACTION_PHASE_SECONDS, () => this.resolveActionPhase(room.code));
    }

    // Between rounds. The first action phase of a game is announced by
    // `coin:gameStarted` instead, so it arms the timer without this broadcast.
    static startActionPhase(roomCode: string) {
        const room = getCoinRoom(roomCode);
        if (!room) return;

        this.armActionPhase(room);

        const doomed = room.game.doomedRing();
        this.io.to(roomCode).emit('coin:phaseChanged', ResponseUtil.success({
            data: {
                phase: 'action',
                timeLimit: ACTION_PHASE_SECONDS,
                roundNumber: room.game.roundNumber + 1,
                // Highlighted for the entire round before it burns (§5.6).
                doomedRing: doomed ? doomed.tiles : null,
            },
        }));
    }

    static resolveActionPhase(roomCode: string) {
        const room = getCoinRoom(roomCode);
        if (!room) return;

        this.clearPhaseTimer(room);
        const results = room.game.resolveActions();

        // Private, one message per player: where you ended up and what you
        // earned. Public wallets do not move until the end of the round, which
        // is what makes the round-over-round delta a read rather than a
        // broadcast (§5.7, §10).
        for (const result of results) {
            this.io.to(result.playerId).emit('coin:actionResolved', ResponseUtil.success({ data: result }));
        }

        this.startAttackPhase(roomCode);
    }

    static startAttackPhase(roomCode: string) {
        const room = getCoinRoom(roomCode);
        if (!room) return;

        room.game.state = 'attack';

        const doomed = room.game.doomedRing();
        this.io.to(roomCode).emit('coin:phaseChanged', ResponseUtil.success({
            data: {
                phase: 'attack',
                timeLimit: ATTACK_PHASE_SECONDS,
                roundNumber: room.game.roundNumber + 1,
                doomedRing: doomed ? doomed.tiles : null,
            },
        }));

        this.startPhaseTimer(room, ATTACK_PHASE_SECONDS, () => this.processRound(roomCode));
    }

    static processRound(roomCode: string) {
        const room = getCoinRoom(roomCode);
        if (!room) return;

        room.game.state = 'process';
        this.clearPhaseTimer(room);

        const result = room.game.resolveRound();
        const newLogs = room.game.roundLogs;

        // Bombs detonate one at a time in resolve order -- that beat is how a
        // player reads who died to whom -- but the beat shortens as the round
        // gets busier, so 20 bombers cost 12s rather than 30s (§15). The client
        // scales its own animation constants by this, so there is one source of
        // truth for the pacing.
        const stepMs = bombStepMs(result.explosions.length);

        this.io.to(roomCode).emit('coin:roundResolved', ResponseUtil.success({
            data: {
                explosions: result.explosions,
                stepMs,
                // Tiles only. Everyone sees that a shield broke there -- that
                // is what turns a shield into "+1 life, and run" rather than
                // "+1 life" -- but never whose it was (§10).
                shieldBreaks: result.shieldBreaks.map(b => ({ x: b.x, y: b.y })),
                laser: result.laser,
                newDestroyedTiles: result.newDestroyedTiles,
                destroyedTiles: room.game.destroyedTiles,
                burnedPiles: room.game.burnedPiles(),
                // Carries the refreshed public wallets, totals only.
                players: room.game.getPlayersList(),
                newLogs,
                roundNumber: result.roundNumber,
            },
        }));

        // The bounty goes only to the killer. The public log names killer and
        // victim without an amount, because kills are public but wallets are
        // not until the round ends (§10).
        for (const reward of result.killRewards) {
            this.io.to(reward.killerId).emit('coin:killReward', ResponseUtil.success({ data: reward }));
        }

        // Hacks are never animated and never logged publicly. Broadcasting them
        // would hand the room a "living player near here" beacon every round --
        // far stronger than the leak the end-of-round wallet refresh
        // deliberately blunts (§10).
        for (const hack of result.hackResults) {
            this.io.to(hack.hackerId).emit('coin:hackResult', ResponseUtil.success({ data: hack }));
        }

        // The victim is told what it cost and nothing else: no tile, no name.
        for (const loss of result.hackLosses) {
            this.io.to(loss.victimId).emit('coin:hacked', ResponseUtil.success({ data: loss }));
        }

        // The owner needs to know their shield is spent -- it is a state
        // change, not just a sprite. Deliberately nothing goes the other way:
        // telling the bomber whose shield they broke would hand them identity
        // *and* position, which is the strongest information in the game and
        // the opposite of what "position revealed, identity not" means.
        for (const broken of result.shieldBreaks) {
            this.io.to(broken.ownerId).emit('coin:shieldBroken', ResponseUtil.success({
                data: { x: broken.x, y: broken.y },
            }));
        }

        const animationMs = result.explosions.length * stepMs;
        const laserAnimationMs = result.laser ? LASER_ANIM_MS : 0;
        const totalDelayMs = ROUND_ANIM_BUFFER_MS + animationMs + laserAnimationMs;

        room.processTimer = setTimeout(() => {
            if (result.endReason) {
                this.endGame(roomCode, result.endReason);
            } else {
                this.startActionPhase(roomCode);
            }
        }, totalDelayMs);
    }

    private static endGame(roomCode: string, reason: CoinEndReason) {
        const room = getCoinRoom(roomCode);
        if (!room) return;

        room.game.state = 'end';
        this.io.to(roomCode).emit('coin:gameOver', ResponseUtil.success({
            data: {
                reason,
                ranking: room.game.getRanking(),
                // Every player's final tile, not just the winner's (§11).
                finalPositions: room.game.getFinalPositions(),
            },
        }));
    }

    // Re-evaluates the early-exit gates after the set of connected players
    // changed (someone dropped, or came back). Deliberately does NOT end the
    // game: a disconnect is not a death (ADR-0001), so it can never be what
    // brings the alive count down to a winner.
    //
    // The lobby has no gate and no timer -- it waits on the host's start
    // button, which the client re-evaluates from the roster.
    static checkGameProgression(roomCode: string) {
        const room = getCoinRoom(roomCode);
        if (!room) return;

        if (room.game.state === 'action' && room.game.haveAllLivingPlayersActed()) {
            this.clearPhaseTimer(room);
            this.resolveActionPhase(roomCode);
        } else if (room.game.state === 'attack' && room.game.haveAllAttackersLockedIn()) {
            this.clearPhaseTimer(room);
            this.processRound(roomCode);
        }
    }

    // ==========================================
    // USER-INITIATED ACTIONS (From the Gateway)
    // ==========================================

    static handleUpdateSettings(
        roomCode: string,
        patch: Partial<CoinModeSettings>,
    ): CoinGameResult<CoinModeSettings, CoinActionErrorType> {
        const room = getCoinRoom(roomCode);
        if (!room) return { success: false, error: 'ROOM_NOT_FOUND' };

        const result = room.game.updateSettings(patch);
        if (!result.success) return { success: false, error: result.error };

        return { success: true, data: result.data };
    }

    static handleSetPosition(
        roomCode: string,
        playerId: string,
        x: number,
        y: number,
    ): CoinGameResult<void, CoinActionErrorType> {
        const room = getCoinRoom(roomCode);
        if (!room) return { success: false, error: 'ROOM_NOT_FOUND' };

        const result = room.game.setPlayerPosition(playerId, x, y);
        if (!result.success) return { success: false, error: result.error };

        return { success: true };
    }

    // The host can force-start, random-assigning anyone who hasn't picked --
    // otherwise one connected-but-AFK player blocks the room forever, since the
    // lobby has no timer (§4).
    static handleStartGame(roomCode: string, force: boolean): CoinGameResult<CoinStartGameResultData, CoinActionErrorType> {
        const room = getCoinRoom(roomCode);
        if (!room) return { success: false, error: 'ROOM_NOT_FOUND' };

        // Noted before the engine assigns tiles, so we know who to tell.
        const unpositioned = room.game.players.filter(p => p.isAlive && !p.hasPositioned).map(p => p.id);

        const result = room.game.beginGame(force);
        if (!result.success) return { success: false, error: result.error };

        for (const playerId of unpositioned) {
            const player = room.game.findPlayer(playerId);
            if (!player) continue;
            // A direct, private message to only this player. Addressed by
            // playerId (every socket joins a room of that name), so it survives
            // a socket swap instead of dying with the old id.
            this.io.to(playerId).emit('coin:forcedPosition', ResponseUtil.success({
                data: { x: player.x, y: player.y },
            }));
        }

        this.armActionPhase(room);

        const doomed = room.game.doomedRing();
        return {
            success: true,
            data: {
                boardSize: { width: room.game.board.width, height: room.game.board.height },
                state: room.game.state,
                piles: room.game.piles,
                settings: room.game.settings,
                destroyedTiles: room.game.destroyedTiles,
                doomedRing: doomed ? doomed.tiles : null,
                timeLimit: ACTION_PHASE_SECONDS,
                roundNumber: room.game.roundNumber + 1,
                players: room.game.getPlayersList(),
                dials: COIN_DIALS,
            },
        };
    }

    static handleChooseAction(
        roomCode: string,
        playerId: string,
        type: CoinActionType,
        target?: Coordinate,
    ): CoinGameResult<void, CoinActionErrorType> {
        const room = getCoinRoom(roomCode);
        if (!room) return { success: false, error: 'ROOM_NOT_FOUND' };

        const result = room.game.setPlayerAction(playerId, type, target);
        if (!result.success) return { success: false, error: result.error };

        // The phase ends early once every connected living player has locked in
        // (§5.1).
        if (room.game.haveAllLivingPlayersActed()) {
            this.clearPhaseTimer(room);
            this.resolveActionPhase(roomCode);
        }

        return { success: true };
    }

    static handleThrowBomb(
        roomCode: string,
        playerId: string,
        targets: Coordinate[],
    ): CoinGameResult<{ resolveOrder: number }, CoinActionErrorType> {
        const room = getCoinRoom(roomCode);
        if (!room) return { success: false, error: 'ROOM_NOT_FOUND' };

        const result = room.game.setPlayerBomb(playerId, targets);
        if (!result.success) return { success: false, error: result.error };

        if (room.game.haveAllAttackersLockedIn()) {
            this.clearPhaseTimer(room);
            this.processRound(roomCode);
        }

        return { success: true, data: result.data };
    }

    static handleHack(
        roomCode: string,
        playerId: string,
        targets: Coordinate[],
    ): CoinGameResult<{ resolveOrder: number }, CoinActionErrorType> {
        const room = getCoinRoom(roomCode);
        if (!room) return { success: false, error: 'ROOM_NOT_FOUND' };

        const result = room.game.setPlayerHack(playerId, targets);
        if (!result.success) return { success: false, error: result.error };

        // The attack phase waits on the living and the dead together, so a
        // hack can be what closes it.
        if (room.game.haveAllAttackersLockedIn()) {
            this.clearPhaseTimer(room);
            this.processRound(roomCode);
        }

        return { success: true, data: result.data };
    }

    static handleBuyItem(
        roomCode: string,
        playerId: string,
        item: CoinItem,
    ): CoinGameResult<{ wallet: number }, CoinActionErrorType> {
        const room = getCoinRoom(roomCode);
        if (!room) return { success: false, error: 'ROOM_NOT_FOUND' };

        const result = room.game.buyItem(playerId, item);
        if (!result.success) return { success: false, error: result.error };

        return { success: true, data: result.data };
    }

    static handleResetGame(roomCode: string): CoinGameResult<CoinResetGameResultData, CoinResetGameErrorType> {
        const room = getCoinRoom(roomCode);
        if (!room) return { success: false, error: 'ROOM_NOT_FOUND' };
        if (room.game.state !== 'end') return { success: false, error: 'WRONG_PHASE' };

        room.game.state = 'lobby';

        this.clearPhaseTimer(room);
        if (room.processTimer) clearTimeout(room.processTimer);
        room.processTimer = null;

        // Anyone still offline when the game wraps up is dropped from the room;
        // everyone who sat this one out on the bench joins the next game.
        room.game.players = room.game.players.filter(p => !p.isDisconnected);
        room.game.promoteSpectatorsToPlayers();

        // The pruning above can take the host with it, leaving the room in
        // lobby with a start button nobody owns.
        if (!room.game.players.some(p => p.id === room.hostId) && room.game.players.length > 0) {
            room.hostId = room.game.players[0].id;
        }

        // Wallets return to the starting stake and piles re-roll. Host settings
        // deliberately survive, so a group tunes once per session (§2, §9).
        room.game.resetGame();

        return {
            success: true,
            data: {
                players: room.game.getPlayersList(),
                spectators: room.game.getSpectatorsList(),
                hostId: room.hostId,
                piles: room.game.piles,
                settings: room.game.settings,
            },
        };
    }

    // ==========================================
    // SNAPSHOT (private, to a (re)entering socket)
    // ==========================================

    static buildRoomSnapshot(roomCode: string, playerId: string, isSpectator: boolean): CoinRoomSnapshot | null {
        const room = getCoinRoom(roomCode);
        if (!room) return null;

        const doomed = room.game.doomedRing();

        const snapshot: CoinRoomSnapshot = {
            state: room.game.state,
            roundNumber: room.game.roundNumber + 1,
            boardSize: { width: room.game.board.width, height: room.game.board.height },
            destroyedTiles: room.game.destroyedTiles,
            piles: room.game.piles,
            burnedPiles: room.game.burnedPiles(),
            doomedRing: doomed ? doomed.tiles : null,
            settings: room.game.settings,
            dials: COIN_DIALS,
            timeLimit: this.phaseTimeLimit(room),
            remainingMs: room.phaseEndsAt ? Math.max(0, room.phaseEndsAt - Date.now()) : 0,
            players: room.game.getPlayersList(),
            spectators: room.game.getSpectatorsList(),
            logs: room.game.roundLogs,
            isSpectator,
            hostId: room.hostId,
        };

        if (!isSpectator) {
            const player = room.game.findPlayer(playerId);
            if (player) {
                snapshot.you = {
                    x: player.x,
                    y: player.y,
                    hasPositioned: player.hasPositioned,
                    isAlive: player.isAlive,
                    isDisconnected: player.isDisconnected,
                    wallet: player.wallet,
                    hasShield: player.hasShield,
                    teleporterArmed: player.teleporterArmed,
                    bombUpgrade: player.bombUpgrade,
                    hasSuperHack: player.hasSuperHack,
                    hasDoubleHack: player.hasDoubleHack,
                    boughtThisRound: player.boughtThisRound,
                    pendingAction: player.pendingAction,
                    bombTargets: player.bombTargets,
                    hackTargets: player.hackTargets,
                    resolveOrder: player.resolveOrder,
                };
            }
        }

        if (room.game.state === 'end') {
            snapshot.ranking = room.game.getRanking();
            snapshot.finalPositions = room.game.getFinalPositions();
        }

        return snapshot;
    }

    // Coin mode's two phases run to different clocks, so the length a client
    // should draw its timer bar against depends on which one is running. Simple
    // mode's single exported PHASE_TIME_LIMIT_SECONDS has no equivalent here --
    // the client must take the length from the payload, never from a constant.
    private static phaseTimeLimit(room: CoinRoom): number {
        switch (room.game.state) {
            case 'action':
                return ACTION_PHASE_SECONDS;
            case 'attack':
                return ATTACK_PHASE_SECONDS;
            default:
                // The lobby waits on the host, and process/end are not timed.
                return 0;
        }
    }
}

export default CoinGameService;
