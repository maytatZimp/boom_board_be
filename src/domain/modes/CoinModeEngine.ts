import Board from '../models/Board';
import CoinPlayerEntity, { CoinActionType } from '../models/CoinPlayerEntity';
import SpectatorEntity from '../models/SpectatorEntity';
import { RoomActionLog, RoomEngine } from './RoomEngine';
import {
    Coordinate,
    isAdjacent8,
    neighboursCardinal,
    placePiles,
    ringTiles,
    sameTile,
} from './coin/BoardGeometry';
import { collectRate, halfWallet } from './coin/Economy';
import {
    CoinModeSettings,
    DEFAULT_SETTINGS,
    LASER_RINGS_BURNED,
    PILE_COUNT,
    PILE_MIN_SPACING,
    HACK_STEAL,
    HACK_STEAL_SUPER,
    HACK_TARGETS,
    HACK_TARGETS_DOUBLED,
    ITEM_COSTS,
    SETTING_RANGES,
    TRIPLE_BOMB_TARGETS,
} from './coin/constants';

// Coin mode: hide and throw, plus an economy. Collect coins, spend them on
// items, steal them from each other; the richest player wins, alive or dead.
//
// Deliberately a separate engine from SimpleModeEngine rather than a subclass
// or a configured variant: the two modes diverge on what a round even is, and
// simple mode is the one people currently play. Nothing here can change it.
//
// The full ruleset lives in `.claude/plans/coin-mode.md`; section references
// below point at it.

export type CoinGameState = 'lobby' | 'action' | 'attack' | 'process' | 'end';

export type CoinLogActionType =
    | 'BOMB_EXPLODED'
    | 'PLAYER_ELIMINATED'
    | 'PLAYER_DISCONNECTED'
    | 'LASER_FIRED'
    | 'COIN_TARGET_REACHED';

export interface BombExplodedData {
    bomberId: string;
    bomberName: string;
    x: number;
    y: number;
}

// Deliberately without the bounty. Kills are public but wallets refresh only at
// end of round (§10), so naming the amount here would leak both players'
// wallets mid-round, and precisely. The killer is told privately instead.
export interface PlayerEliminatedData {
    bomberId: string;
    bomberName: string;
    victimId: string;
    victimName: string;
}

export interface PlayerDisconnectedData {
    playerId: string;
    playerName: string;
}

export interface LaserFiredData {
    ring: number;
    coordinates: Coordinate[];
}

export interface CoinActionLog<T = any> {
    id: string;
    type: CoinLogActionType;
    timestamp: number;
    data: T;
}

// The public shape of a player. `wallet` is the published total, never the live
// one -- see CoinPlayerEntity.publicWallet.
export interface CoinPlayerModel {
    id: string;
    name: string;
    wallet: number;
    isAlive: boolean;
    hasPositioned: boolean;
    isDisconnected: boolean;
    // Lock-in markers only. What was chosen, and where, stays private.
    hasLockedAction: boolean;
    hasLockedAttack: boolean;
    resolveOrder: number | null;
}

export interface CoinSpectatorModel {
    id: string;
    name: string;
}

export type SetPositionErrorType =
    | 'PLAYER_NOT_FOUND'
    | 'INVALID_COORDINATES'
    | 'TILE_ALREADY_DESTROYED'
    | 'WRONG_PHASE';

export type UpdateSettingsErrorType = 'WRONG_PHASE' | 'INVALID_SETTING';

export type SetActionErrorType =
    | 'PLAYER_NOT_FOUND'
    | 'DEAD_PLAYER'
    | 'WRONG_PHASE'
    | 'ACTION_ALREADY_LOCKED'
    | 'MISSING_TARGET'
    | 'INVALID_COORDINATES'
    | 'TILE_ALREADY_DESTROYED'
    | 'TILE_NOT_ADJACENT'
    | 'NOT_A_MOVE';

export type SetHackErrorType =
    | 'PLAYER_NOT_FOUND'
    | 'LIVING_PLAYER'
    | 'WRONG_PHASE'
    | 'HACK_ALREADY_LOCKED'
    | 'WRONG_TARGET_COUNT'
    | 'INVALID_COORDINATES'
    | 'TILE_ALREADY_DESTROYED';

export type BuyItemErrorType =
    | 'PLAYER_NOT_FOUND'
    | 'WRONG_PHASE'
    | 'UNKNOWN_ITEM'
    | 'WRONG_LIFE_STATUS'
    | 'ALREADY_OWNED'
    | 'ALREADY_LOCKED'
    | 'ALREADY_BOUGHT_THIS_ROUND'
    | 'NOT_AFFORDABLE';

export type CoinItem = 'shield' | 'teleporter' | 'tripleBomb' | 'bigBomb' | 'superHack' | 'doubleHack';

type ItemRule = {
    cost: number;
    phase: CoinGameState;
    forLiving: boolean;
    // Whether buying it after you have already committed this round's choice
    // would be throwing coins away. A Shield bought after locking in a Collect
    // still blocks a bomb; a Teleporter bought after locking in a Move cannot
    // retroactively widen where that Move could go.
    needsUnlockedChoice: boolean;
    owned: (player: CoinPlayerEntity) => boolean;
    grant: (player: CoinPlayerEntity) => void;
};

// One table rather than a branch per item, so the phase, the cost and the
// "already got one" rule for each sit in a single readable row.
const ITEM_RULES: Record<CoinItem, ItemRule> = {
    shield: {
        cost: ITEM_COSTS.shield,
        phase: 'action',
        forLiving: true,
        needsUnlockedChoice: false,
        owned: p => p.hasShield,
        grant: p => { p.hasShield = true; },
    },
    teleporter: {
        cost: ITEM_COSTS.teleporter,
        phase: 'action',
        forLiving: true,
        needsUnlockedChoice: true,
        owned: p => p.teleporterArmed,
        grant: p => { p.teleporterArmed = true; },
    },
    tripleBomb: {
        cost: ITEM_COSTS.tripleBomb,
        phase: 'attack',
        forLiving: true,
        needsUnlockedChoice: true,
        // Triple and Big do not combine, so holding either closes the other.
        owned: p => p.bombUpgrade !== null,
        grant: p => { p.bombUpgrade = 'triple'; },
    },
    bigBomb: {
        cost: ITEM_COSTS.bigBomb,
        phase: 'attack',
        forLiving: true,
        needsUnlockedChoice: true,
        owned: p => p.bombUpgrade !== null,
        grant: p => { p.bombUpgrade = 'big'; },
    },
    superHack: {
        cost: ITEM_COSTS.superHack,
        phase: 'attack',
        forLiving: false,
        needsUnlockedChoice: true,
        owned: p => p.hasSuperHack,
        grant: p => { p.hasSuperHack = true; },
    },
    doubleHack: {
        cost: ITEM_COSTS.doubleHack,
        phase: 'attack',
        forLiving: false,
        needsUnlockedChoice: true,
        owned: p => p.hasDoubleHack,
        grant: p => { p.hasDoubleHack = true; },
    },
};

export type SetBombErrorType =
    | 'PLAYER_NOT_FOUND'
    | 'DEAD_PLAYER'
    | 'WRONG_PHASE'
    | 'BOMB_ALREADY_THROWN'
    | 'WRONG_TARGET_COUNT'
    | 'DUPLICATE_TARGET'
    | 'INVALID_COORDINATES'
    | 'TILE_ALREADY_DESTROYED';

// Where a player ended up and what they earned. Private: public wallets do not
// move until the end of the round (§5.7).
export interface CoinActionResult {
    playerId: string;
    x: number;
    y: number;
    wallet: number;
    collected: number;
    moved: boolean;
}

// One bomb landing on one tile. `victimIds` is a list because coin mode allows
// stacking -- a bomb on a crowded pile paying out several times over is the
// biggest moment in the game (§9).
export interface CoinExplosionResult {
    bomberId: string;
    // Where it was aimed. A Big Bomb also covers the four cardinal neighbours,
    // which are listed in `blastTiles` rather than sent as separate bombs, so
    // one bomb stays one beat of the animation.
    x: number;
    y: number;
    blastTiles: Coordinate[];
    isHit: boolean;
    victimIds: string[];
    // Who survived it on a shield. They are not dead, so they are deliberately
    // not in `victimIds`.
    shieldedIds: string[];
}

// Everyone sees the broken-shield sprite at the tile: position revealed,
// identity not (§10). The ids stay server-side for the private note to the
// owner -- a shield that broke is a state change they must be told about.
export interface CoinShieldBreak {
    x: number;
    y: number;
    ownerId: string;
    bomberId: string;
}

// The bounty a kill paid, sent privately to the killer. It is deliberately
// absent from the public log: kills are public but wallets refresh only at end
// of round, so naming the amount would leak both wallets mid-round (§10).
export interface CoinKillReward {
    killerId: string;
    victimId: string;
    amount: number;
}

export interface CoinLaserResult {
    ring: number;
    tiles: Coordinate[];
    victims: { playerId: string; x: number; y: number }[];
}

// One tile a hack named, and what it found there. Recorded even when it took
// nothing: a drained victim is still a living player standing on that tile, and
// that is the information a hack is really buying.
export interface CoinHackHit {
    x: number;
    y: number;
    victimId: string;
    amount: number;
}

// Private to the hacker. Per-tile attribution is safe to give them because they
// are still competing for the win, so feeding positions to a living rival over
// voice chat costs them the game (ADR-0002).
export interface CoinHackResult {
    hackerId: string;
    hits: CoinHackHit[];
    total: number;
}

// Private to the victim, and deliberately thinner: an amount with no
// attribution and no tile. Broadcasting hack results would hand the room a
// "living player near here" beacon every round.
export interface CoinHackLoss {
    victimId: string;
    amount: number;
}

export type CoinEndReason = 'COIN_TARGET' | 'LAST_PLAYER' | 'ROUND_LIMIT';

export interface CoinRoundResolution {
    roundNumber: number;
    explosions: CoinExplosionResult[];
    killRewards: CoinKillReward[];
    hackResults: CoinHackResult[];
    hackLosses: CoinHackLoss[];
    shieldBreaks: CoinShieldBreak[];
    laser: CoinLaserResult | null;
    newDestroyedTiles: Coordinate[];
    endReason: CoinEndReason | null;
}

export interface CoinRankingModel {
    rank: number;
    id: string;
    name: string;
    wallet: number;
    isAlive: boolean;
    isDisconnected: boolean;
}

export type StartGameErrorType = 'WRONG_PHASE' | 'NOT_ENOUGH_PLAYERS' | 'PLAYERS_NOT_READY';

export interface EngineResult<TData = any, TError = string> {
    success: boolean;
    data?: TData;
    error?: TError;
}

class CoinModeEngine {
    state: CoinGameState = 'lobby';
    board: Board;
    players: CoinPlayerEntity[];
    spectators: SpectatorEntity[];
    maxPlayers: number;
    maxSpectators: number;

    // Host-tunable, locked once play starts, and deliberately NOT reset by
    // resetGame() -- a group tunes once per session, not once per game (§2).
    settings: CoinModeSettings;

    // Placed in the lobby rather than at game start: they are visible from the
    // lobby onward and lobby picks are meant to be informed by them (§3).
    // Never relocated for the life of the game.
    piles: Coordinate[];

    destroyedTiles: Coordinate[];
    roundNumber: number;
    resolveCounter: number;
    deathCounter: number;
    roundLogs: CoinActionLog[];
    private logIdCounter: number;

    constructor() {
        this.board = new Board(8, 8);
        this.players = [];
        this.spectators = [];
        this.maxPlayers = 64;
        this.maxSpectators = 64;
        this.settings = { ...DEFAULT_SETTINGS };
        this.piles = this.rollPiles();
        this.destroyedTiles = [];
        this.roundNumber = 0;
        this.resolveCounter = 0;
        this.deathCounter = 0;
        this.roundLogs = [];
        this.logIdCounter = 0;
    }

    private rollPiles(): Coordinate[] {
        return placePiles(PILE_COUNT, PILE_MIN_SPACING, this.board.width, this.board.height);
    }

    // ==========================================
    // ROSTER (the RoomEngine contract)
    // ==========================================

    addNewPlayer(id: string, name: string, secret: string): boolean {
        if (this.players.length >= this.maxPlayers) return false;
        this.players.push(new CoinPlayerEntity(id, name, secret));
        return true;
    }

    addSpectator(spectator: SpectatorEntity): boolean {
        if (this.spectators.length >= this.maxSpectators) return false;
        this.spectators.push(spectator);
        return true;
    }

    removeSpectator(spectatorId: string): boolean {
        const index = this.spectators.findIndex(s => s.id === spectatorId);
        if (index === -1) return false;
        this.spectators.splice(index, 1);
        return true;
    }

    // Everyone who sat out this game joins the next one. Called on the
    // end -> lobby reset, after disconnected players have been pruned.
    promoteSpectatorsToPlayers(): void {
        for (const spectator of this.spectators) {
            this.addNewPlayer(spectator.id, spectator.name, spectator.secret);
        }
        this.spectators = [];
    }

    getPlayersList(): CoinPlayerModel[] {
        return this.players.map(p => ({
            id: p.id,
            name: p.name,
            wallet: p.publicWallet,
            isAlive: p.isAlive,
            hasPositioned: p.hasPositioned,
            isDisconnected: p.isDisconnected,
            hasLockedAction: p.pendingAction !== null,
            hasLockedAttack: p.resolveOrder !== null,
            resolveOrder: p.resolveOrder,
        }));
    }

    getSpectatorsList(): CoinSpectatorModel[] {
        return this.spectators.map(s => ({ id: s.id, name: s.name }));
    }

    findPlayer(playerId: string): CoinPlayerEntity | undefined {
        return this.players.find(p => p.id === playerId);
    }

    // ==========================================
    // PHASE POPULATIONS (§13)
    // ==========================================

    // Who the action phase waits for: on the board, holding a client. A
    // disconnected player will never act, so counting them would strand the
    // phase on its full timer.
    connectedLivingPlayers(): CoinPlayerEntity[] {
        return this.players.filter(p => p.isAlive && !p.isDisconnected);
    }

    // Who the attack phase waits for. Wider than the action phase's population
    // by exactly the dead, who hack rather than bomb -- that difference is the
    // whole reason the two phases need separate gates.
    connectedActingPlayers(): CoinPlayerEntity[] {
        return this.players.filter(p => !p.isDisconnected);
    }

    livingPlayers(): CoinPlayerEntity[] {
        return this.players.filter(p => p.isAlive);
    }

    // ==========================================
    // BOARD QUERIES
    // ==========================================

    isDestroyed(x: number, y: number): boolean {
        return this.destroyedTiles.some(t => t.x === x && t.y === y);
    }

    isPile(x: number, y: number): boolean {
        return this.piles.some(p => p.x === x && p.y === y);
    }

    // A pile whose own tile the laser took. It still pays the adjacent rate to
    // its neighbours, but nobody can stand on it and nobody can bomb it -- so
    // the ring around a burned pile is worth more than it looks.
    burnedPiles(): Coordinate[] {
        return this.piles.filter(p => this.isDestroyed(p.x, p.y));
    }

    // Living players standing on a tile. Coin mode allows stacking, unlike
    // simple mode -- a bomb on a crowded pile paying out three times over is
    // the biggest moment in the game (§9), so this returns a list, not one.
    livingPlayersAt(x: number, y: number): CoinPlayerEntity[] {
        return this.players.filter(p => p.isAlive && p.hasPositioned && p.x === x && p.y === y);
    }

    // The ring the laser will take at the end of the current round, highlighted
    // for that entire round beforehand (§5.6). Null once the laser has closed
    // its three rings and stopped, or when the host turned it off.
    doomedRing(): { ring: number; tiles: Coordinate[] } | null {
        const start = this.settings.laserStartRound;
        if (start === null) return null;
        if (this.state === 'lobby' || this.state === 'end') return null;

        // `roundNumber` counts rounds already resolved, so the round being
        // played is the next one.
        const currentRound = this.roundNumber + 1;
        if (currentRound < start) return null;

        const ring = currentRound - start;
        if (ring >= LASER_RINGS_BURNED) return null;

        return { ring, tiles: ringTiles(ring, this.board.width, this.board.height) };
    }

    // ==========================================
    // LOBBY (§4) -- positioning is folded in, there is no position phase
    // ==========================================

    // Re-pickable until the host starts: a lobby pick is a plan, not a lock-in,
    // and others only ever see that you have one.
    setPlayerPosition(playerId: string, x: number, y: number): EngineResult<void, SetPositionErrorType> {
        if (this.state !== 'lobby') return { success: false, error: 'WRONG_PHASE' };

        const player = this.findPlayer(playerId);
        if (!player) return { success: false, error: 'PLAYER_NOT_FOUND' };
        if (!this.board.isValidPosition(x, y)) return { success: false, error: 'INVALID_COORDINATES' };
        if (this.isDestroyed(x, y)) return { success: false, error: 'TILE_ALREADY_DESTROYED' };

        player.setPosition(x, y);
        return { success: true };
    }

    haveAllPlayersPositioned(): boolean {
        const waitingOn = this.connectedLivingPlayers();
        if (waitingOn.length === 0) return false;
        return waitingOn.every(p => p.hasPositioned);
    }

    // Unlike simple mode, this does NOT avoid occupied tiles: stacking is legal
    // and the economy is built on crowded piles.
    forceRandomPosition(playerId: string): void {
        const player = this.findPlayer(playerId);
        if (!player || !player.isAlive || player.hasPositioned) return;

        const open: Coordinate[] = [];
        for (let x = 0; x < this.board.width; x++) {
            for (let y = 0; y < this.board.height; y++) {
                if (!this.isDestroyed(x, y)) open.push({ x, y });
            }
        }
        if (open.length === 0) return;

        const tile = open[Math.floor(Math.random() * open.length)];
        player.setPosition(tile.x, tile.y);
    }

    // The start button's own gate. The host can override it with a force-start,
    // which random-assigns anyone who hasn't picked -- otherwise one
    // connected-but-AFK player blocks the room forever, since the lobby has no
    // timer (§4).
    canStart(): boolean {
        return this.players.length >= 2 && this.haveAllPlayersPositioned();
    }

    beginGame(force: boolean): EngineResult<void, StartGameErrorType> {
        if (this.state !== 'lobby') return { success: false, error: 'WRONG_PHASE' };
        if (this.players.length < 2) return { success: false, error: 'NOT_ENOUGH_PLAYERS' };
        if (!force && !this.haveAllPlayersPositioned()) {
            return { success: false, error: 'PLAYERS_NOT_READY' };
        }

        // Covers both the force-start path and the disconnected-alive players,
        // who are never part of the ready gate but still need a tile.
        this.players.forEach(p => {
            if (p.isAlive && !p.hasPositioned) this.forceRandomPosition(p.id);
        });

        // Round 1 begins directly at the action phase -- everyone is already
        // positioned (§5).
        this.state = 'action';
        return { success: true };
    }

    // ==========================================
    // HOST SETTINGS (§2)
    // ==========================================

    updateSettings(patch: Partial<CoinModeSettings>): EngineResult<CoinModeSettings, UpdateSettingsErrorType> {
        if (this.state !== 'lobby') return { success: false, error: 'WRONG_PHASE' };

        const next: CoinModeSettings = { ...this.settings };

        if (patch.coinTarget !== undefined) {
            if (!inRange(patch.coinTarget, SETTING_RANGES.coinTarget)) {
                return { success: false, error: 'INVALID_SETTING' };
            }
            next.coinTarget = patch.coinTarget;
        }

        if (patch.roundLimit !== undefined) {
            if (!inRange(patch.roundLimit, SETTING_RANGES.roundLimit)) {
                return { success: false, error: 'INVALID_SETTING' };
            }
            next.roundLimit = patch.roundLimit;
        }

        if (patch.laserStartRound !== undefined) {
            // null is a real value here: the laser off entirely.
            if (patch.laserStartRound !== null && !inRange(patch.laserStartRound, SETTING_RANGES.laserStartRound)) {
                return { success: false, error: 'INVALID_SETTING' };
            }
            next.laserStartRound = patch.laserStartRound;
        }

        this.settings = next;
        return { success: true, data: this.settings };
    }

    // ==========================================
    // ACTION PHASE (§5.1, §5.2)
    // ==========================================

    // A single-pick choice locks in immediately on submit and cannot be changed
    // (§5.1). There is no take-back window, which is what makes deciding early
    // free and deciding late a tempo cost.
    setPlayerAction(playerId: string, type: CoinActionType, target?: Coordinate): EngineResult<void, SetActionErrorType> {
        if (this.state !== 'action') return { success: false, error: 'WRONG_PHASE' };

        const player = this.findPlayer(playerId);
        if (!player) return { success: false, error: 'PLAYER_NOT_FOUND' };
        if (!player.isAlive) return { success: false, error: 'DEAD_PLAYER' };
        if (player.pendingAction !== null) return { success: false, error: 'ACTION_ALREADY_LOCKED' };

        if (type === 'collect') {
            player.setAction({ type: 'collect' });
            return { success: true };
        }

        if (!target) return { success: false, error: 'MISSING_TARGET' };
        if (!this.board.isValidPosition(target.x, target.y)) return { success: false, error: 'INVALID_COORDINATES' };
        if (this.isDestroyed(target.x, target.y)) return { success: false, error: 'TILE_ALREADY_DESTROYED' };

        const from = { x: player.x as number, y: player.y as number };
        // Staying put is what Collect is for -- a Move that goes nowhere would
        // be a free way to earn nothing, which is nobody's intent (§6).
        if (sameTile(from, target)) return { success: false, error: 'NOT_A_MOVE' };
        // A Teleporter lets this round's Move target any non-destroyed tile.
        if (!player.teleporterArmed && !isAdjacent8(from, target)) {
            return { success: false, error: 'TILE_NOT_ADJACENT' };
        }

        player.setAction({ type: 'move', target });
        return { success: true };
    }

    haveAllLivingPlayersActed(): boolean {
        const waitingOn = this.connectedLivingPlayers();
        if (waitingOn.length === 0) return false;
        return waitingOn.every(p => p.pendingAction !== null);
    }

    resolveActions(): CoinActionResult[] {
        // Timeout default is Collect (§5.1). A disconnected living player
        // collects normally at whatever tile they are on (§12): they never
        // move, so a disconnected pile camper posts the pile rate every round
        // and becomes the easiest read on the board. The passive income is
        // self-correcting, which is why it is allowed to continue.
        this.players.forEach(p => {
            if (p.isAlive && p.pendingAction === null) p.setAction({ type: 'collect' });
        });

        // All moves apply simultaneously, and only then do collects pay, scored
        // against post-move positions (§5.2). That ordering is why reaching a
        // pile costs a round of income and only pays the round after -- and
        // that payout is what announces you.
        this.players.forEach(p => {
            if (!p.isAlive || p.pendingAction?.type !== 'move') return;
            const target = p.pendingAction.target as Coordinate;
            p.setPosition(target.x, target.y);
        });

        const results: CoinActionResult[] = [];
        this.players.forEach(p => {
            if (!p.isAlive) return;
            const moved = p.pendingAction?.type === 'move';
            let collected = 0;
            if (!moved) {
                collected = collectRate({ x: p.x as number, y: p.y as number }, this.piles);
                p.earn(collected);
            }
            results.push({
                playerId: p.id,
                x: p.x as number,
                y: p.y as number,
                wallet: p.wallet,
                collected,
                moved,
            });
        });
        return results;
    }

    // ==========================================
    // ATTACK PHASE (§5.3, §5.4)
    // ==========================================

    // A bomb is free every round -- it does not compete with the action -- so
    // "do I throw?" is not a decision; "where?" is (§7.1).
    setPlayerBomb(playerId: string, targets: Coordinate[]): EngineResult<{ resolveOrder: number }, SetBombErrorType> {
        if (this.state !== 'attack') return { success: false, error: 'WRONG_PHASE' };

        const player = this.findPlayer(playerId);
        if (!player) return { success: false, error: 'PLAYER_NOT_FOUND' };
        if (!player.isAlive) return { success: false, error: 'DEAD_PLAYER' };
        if (player.resolveOrder !== null) return { success: false, error: 'BOMB_ALREADY_THROWN' };

        const expected = player.bombUpgrade === 'triple' ? TRIPLE_BOMB_TARGETS : 1;
        if (targets.length !== expected) return { success: false, error: 'WRONG_TARGET_COUNT' };

        for (const target of targets) {
            if (!this.board.isValidPosition(target.x, target.y)) return { success: false, error: 'INVALID_COORDINATES' };
            if (this.isDestroyed(target.x, target.y)) return { success: false, error: 'TILE_ALREADY_DESTROYED' };
        }

        // A Triple Bomb throws at three *distinct* tiles (§8). Bombing your own
        // tile is legal and risk-free -- a bomb cannot kill its own owner -- so
        // a pile camper should essentially always bomb the pile they stand on.
        if (expected > 1) {
            const seen = new Set(targets.map(t => `${t.x},${t.y}`));
            if (seen.size !== targets.length) return { success: false, error: 'DUPLICATE_TARGET' };
        }

        // One counter shared with hacks, so a fast hacker can rob a victim
        // before the bomber who kills them halves what is left (§5.4).
        const order = this.resolveCounter++;
        player.setBombTargets(targets, order);
        return { success: true, data: { resolveOrder: order } };
    }

    // Name tiles and steal from every living player standing on each (§7.2).
    //
    // The same tile may be named more than once and pays each time. That is
    // load-bearing, not an oversight: without it the maximum threat is 1 coin
    // while fleeing costs 1-3, so a victim would rationally never move. With
    // it, an all-in read threatens 3 (6 with a Super Hack), which is more than
    // any single collect.
    setPlayerHack(playerId: string, targets: Coordinate[]): EngineResult<{ resolveOrder: number }, SetHackErrorType> {
        if (this.state !== 'attack') return { success: false, error: 'WRONG_PHASE' };

        const player = this.findPlayer(playerId);
        if (!player) return { success: false, error: 'PLAYER_NOT_FOUND' };
        if (player.isAlive) return { success: false, error: 'LIVING_PLAYER' };
        if (player.resolveOrder !== null) return { success: false, error: 'HACK_ALREADY_LOCKED' };

        const expected = player.hasDoubleHack ? HACK_TARGETS_DOUBLED : HACK_TARGETS;
        if (targets.length !== expected) return { success: false, error: 'WRONG_TARGET_COUNT' };

        for (const target of targets) {
            if (!this.board.isValidPosition(target.x, target.y)) return { success: false, error: 'INVALID_COORDINATES' };
            if (this.isDestroyed(target.x, target.y)) return { success: false, error: 'TILE_ALREADY_DESTROYED' };
        }

        // The same counter bombs use, so hackers and bombers compete over the
        // same wallets: a fast hacker robs a victim before the bomber who kills
        // them halves what is left (§5.4).
        const order = this.resolveCounter++;
        player.setHackTargets(targets, order);
        return { success: true, data: { resolveOrder: order } };
    }

    // ==========================================
    // SHOP (§8) -- the dead half
    // ==========================================

    // An item is bought in the phase it acts in (§8). For a living player that,
    // plus the one-per-round cap, is what makes defence and offence compete for
    // the same slot: arming yourself in the attack phase means you did not
    // shield yourself in the action phase.
    //
    // Dead players have their own shop and are exempt from the cap, so Super
    // Hack and Double Hack can be bought together.
    //
    // There are no refunds. Buy a Big Bomb, get killed before your slot comes
    // up, and you lose both.
    buyItem(playerId: string, item: CoinItem): EngineResult<{ wallet: number }, BuyItemErrorType> {
        const player = this.findPlayer(playerId);
        if (!player) return { success: false, error: 'PLAYER_NOT_FOUND' };

        const rule = ITEM_RULES[item];
        if (!rule) return { success: false, error: 'UNKNOWN_ITEM' };

        if (this.state !== rule.phase) return { success: false, error: 'WRONG_PHASE' };
        if (rule.forLiving !== player.isAlive) return { success: false, error: 'WRONG_LIFE_STATUS' };

        if (rule.needsUnlockedChoice) {
            const locked = rule.phase === 'action' ? player.pendingAction !== null : player.resolveOrder !== null;
            if (locked) return { success: false, error: 'ALREADY_LOCKED' };
        }

        if (rule.owned(player)) return { success: false, error: 'ALREADY_OWNED' };

        // The living cap spans the whole round, across both phases. The dead
        // are exempt.
        if (player.isAlive && player.boughtThisRound) {
            return { success: false, error: 'ALREADY_BOUGHT_THIS_ROUND' };
        }

        // Validated and deducted at the moment of purchase, out of the same
        // wallet that decides the winner. An action-phase buy therefore cannot
        // spend this round's collect income; an attack-phase buy can.
        if (!player.spend(rule.cost)) return { success: false, error: 'NOT_AFFORDABLE' };

        rule.grant(player);
        if (player.isAlive) player.boughtThisRound = true;

        return { success: true, data: { wallet: player.wallet } };
    }

    // Who the attack phase waits for: everyone still holding a client, living
    // and dead alike. Wider than the action phase by exactly the dead, who hack
    // rather than bomb -- that difference is the whole reason the two phases
    // need separate gates (§13).
    //
    // There is no pass: a living player always bombs because it is free, and a
    // dead player always hacks because it is their only income. The one case
    // that reaches the full timer is a connected player who has walked away.
    haveAllAttackersLockedIn(): boolean {
        const waitingOn = this.connectedActingPlayers();
        if (waitingOn.length === 0) return false;
        return waitingOn.every(p => p.resolveOrder !== null);
    }

    // ==========================================
    // RESOLUTION (§5.4 - §5.7)
    // ==========================================

    resolveRound(): CoinRoundResolution {
        this.roundLogs = [];
        // `roundNumber` counts rounds already resolved, so the one being
        // resolved now is the next.
        const currentRound = this.roundNumber + 1;

        const { explosions, killRewards, hackResults, hackLosses, shieldBreaks } = this.resolveAttacks();

        // Checked once, after every bomb and hack has resolved and before the
        // laser (§5.5). Checking mid-sequence was rejected: crossing the target
        // usually happens by collecting in the action phase, so a mid-sequence
        // check would end the game before a single bomb of the final round
        // resolved, cancelling twenty players' attacks unfired.
        let endReason = this.checkGameEnd(currentRound);

        let laser: CoinLaserResult | null = null;
        if (!endReason) {
            laser = this.fireLaser(currentRound);
            // The pre-laser check is what stops a *last survivor* burning to
            // it. It says nothing about a laser that creates one, and playing
            // on with one or zero players alive is not a state the ruleset
            // describes -- so the board-shrinking death re-opens the question.
            if (laser) endReason = this.checkGameEnd(currentRound);
        }

        if (endReason === 'COIN_TARGET') {
            const reachers = this.players.filter(p => p.wallet >= this.settings.coinTarget);
            this.addLog('COIN_TARGET_REACHED', { playerIds: reachers.map(p => p.id) });
        }

        // Public wallets refresh once, here. Totals only -- never per-round
        // delta badges (§5.7). If the UI computed deltas for players the read
        // would stop being a skill and every pile camper would be instantly
        // mobbed.
        this.players.forEach(p => p.publishWallet());

        this.roundNumber = currentRound;
        this.players.forEach(p => p.resetRound());
        this.resolveCounter = 0;

        return {
            roundNumber: currentRound,
            explosions,
            killRewards,
            hackResults,
            hackLosses,
            shieldBreaks,
            laser,
            newDestroyedTiles: laser ? laser.tiles : [],
            endReason,
        };
    }

    private resolveAttacks(): {
        explosions: CoinExplosionResult[];
        killRewards: CoinKillReward[];
        hackResults: CoinHackResult[];
        hackLosses: CoinHackLoss[];
        shieldBreaks: CoinShieldBreak[];
    } {
        const explosions: CoinExplosionResult[] = [];
        const killRewards: CoinKillReward[] = [];
        const shieldBreaks: CoinShieldBreak[] = [];
        const hackResults: CoinHackResult[] = [];
        // Aggregated per victim: told once that they lost N, never how many
        // hackers found them or from where.
        const lossByVictim = new Map<string, number>();

        const actors = this.players
            .filter(p => p.resolveOrder !== null)
            .sort((a, b) => (a.resolveOrder as number) - (b.resolveOrder as number));

        for (const actor of actors) {
            // A bomber killed earlier in this same order never throws (§5.4).
            // That now costs coins, which makes locking in fast worth more than
            // it is in simple mode.
            //
            // Simple mode's sudden-death break -- stop resolving once one
            // player is left -- is deliberately NOT carried over: it protects a
            // result that survival decides, and here survival decides nothing.
            if (!actor.isAlive) {
                // Bombs and hacks interleave in one shared resolve order, so a
                // dead player's slot comes up exactly where they locked in.
                if (actor.hackTargets) {
                    const result = this.resolveHack(actor, lossByVictim);
                    hackResults.push(result);
                }
                continue;
            }

            if (!actor.bombTargets) continue;

            for (const tile of actor.bombTargets) {
                this.addLog('BOMB_EXPLODED', {
                    bomberId: actor.id,
                    bomberName: actor.name,
                    x: tile.x,
                    y: tile.y,
                } as BombExplodedData);

                const blastTiles = this.blastTilesFor(actor, tile);
                const victimIds: string[] = [];
                const shieldedIds: string[] = [];

                for (const blastTile of blastTiles) {
                    // A bomb cannot kill its own owner, and that holds for a
                    // Big Bomb's arms too (§7.1).
                    const caught = this.livingPlayersAt(blastTile.x, blastTile.y)
                        .filter(v => v.id !== actor.id);

                    for (const victim of caught) {
                        if (victim.hasShield) {
                            // Blocks exactly one bomb, and is gone afterwards:
                            // two bombers in the same round means the second
                            // one kills.
                            victim.consumeShield();
                            shieldedIds.push(victim.id);
                            shieldBreaks.push({
                                x: blastTile.x,
                                y: blastTile.y,
                                ownerId: victim.id,
                                bomberId: actor.id,
                            });
                            continue;
                        }

                        // The bounty is uncapped across stacked victims: a bomb
                        // on a crowded pile pays out once per body (§9).
                        const bounty = halfWallet(victim.wallet);
                        victim.take(bounty);
                        actor.earn(bounty);
                        victim.eliminate(++this.deathCounter);

                        this.addLog('PLAYER_ELIMINATED', {
                            bomberId: actor.id,
                            bomberName: actor.name,
                            victimId: victim.id,
                            victimName: victim.name,
                        } as PlayerEliminatedData);

                        killRewards.push({ killerId: actor.id, victimId: victim.id, amount: bounty });
                        victimIds.push(victim.id);
                    }
                }

                explosions.push({
                    bomberId: actor.id,
                    x: tile.x,
                    y: tile.y,
                    blastTiles,
                    isHit: victimIds.length > 0,
                    victimIds,
                    shieldedIds,
                });
            }
        }

        const hackLosses: CoinHackLoss[] = [...lossByVictim.entries()]
            .map(([victimId, amount]) => ({ victimId, amount }));

        return { explosions, killRewards, hackResults, hackLosses, shieldBreaks };
    }

    // What a single bomb actually covers. A Big Bomb adds the four cardinal
    // neighbours; the arms clip harmlessly at the board edge and over destroyed
    // tiles, so a Big Bomb thrown into a corner is worth less than one thrown
    // into open board.
    private blastTilesFor(bomber: CoinPlayerEntity, target: Coordinate): Coordinate[] {
        if (bomber.bombUpgrade !== 'big') return [target];

        const arms = neighboursCardinal(target.x, target.y, this.board.width, this.board.height)
            .filter(t => !this.isDestroyed(t.x, t.y));

        return [target, ...arms];
    }

    private resolveHack(hacker: CoinPlayerEntity, lossByVictim: Map<string, number>): CoinHackResult {
        const rate = hacker.hasSuperHack ? HACK_STEAL_SUPER : HACK_STEAL;
        const hits: CoinHackHit[] = [];
        let total = 0;

        for (const tile of hacker.hackTargets as Coordinate[]) {
            // Only living players are on the board, so the dead cannot be
            // hacked -- their wallets only ever ratchet upward, and they must
            // not also be safe forever (ADR-0002).
            for (const victim of this.livingPlayersAt(tile.x, tile.y)) {
                // Contested steals resolve by order: the first hacker takes
                // what is there, a later one finds an empty pocket. `take`
                // handles the partial case -- a Super Hack against a victim
                // holding 1 coin takes the 1.
                const amount = victim.take(rate);
                hacker.earn(amount);
                total += amount;

                // Recorded even at 0: the hacker has still learned that a
                // living player is standing there, which is what they paid for.
                hits.push({ x: tile.x, y: tile.y, victimId: victim.id, amount });
                if (amount > 0) {
                    lossByVictim.set(victim.id, (lossByVictim.get(victim.id) ?? 0) + amount);
                }
            }
        }

        return { hackerId: hacker.id, hits, total };
    }

    // A dead player's wallet counts: they are still competing for the win
    // (ADR-0002), so the richest corpse in the room can end the game.
    private checkGameEnd(currentRound: number): CoinEndReason | null {
        if (this.players.some(p => p.wallet >= this.settings.coinTarget)) return 'COIN_TARGET';
        // A 0-alive ending is legitimate: two players trading kills produces
        // it, and the coin ranking still names a winner (§11).
        if (this.livingPlayers().length <= 1) return 'LAST_PLAYER';
        if (currentRound >= this.settings.roundLimit) return 'ROUND_LIMIT';
        return null;
    }

    private fireLaser(currentRound: number): CoinLaserResult | null {
        const start = this.settings.laserStartRound;
        if (start === null) return null;

        const ring = currentRound - start;
        // Three burns and then it stops: the centre 2x2 is permanent board and
        // whoever is left settles it there (§5.6).
        if (ring < 0 || ring >= LASER_RINGS_BURNED) return null;

        const tiles = ringTiles(ring, this.board.width, this.board.height)
            .filter(t => !this.isDestroyed(t.x, t.y));
        if (tiles.length === 0) return null;

        const victims: { playerId: string; x: number; y: number }[] = [];
        for (const tile of tiles) {
            // Unlike simple mode's laser, this one destroys occupied tiles. A
            // shield does not save you -- the telegraph is the counterplay.
            for (const victim of this.livingPlayersAt(tile.x, tile.y)) {
                // Same bite as a bomb death, but destroyed rather than paid:
                // nobody collects (§5.6).
                victim.take(halfWallet(victim.wallet));
                victim.eliminate(++this.deathCounter);
                victims.push({ playerId: victim.id, x: tile.x, y: tile.y });
            }
        }

        this.destroyedTiles.push(...tiles);
        this.addLog('LASER_FIRED', { ring, coordinates: tiles } as LaserFiredData);

        return { ring, tiles, victims };
    }

    // ==========================================
    // ENDING AND RANKING (§11)
    // ==========================================

    // Wallet, then living above dead, then later death above earlier. Survival
    // is a tiebreaker, never an override -- the richest player wins, alive or
    // dead. With most players collecting 1 a round, exact ties are near-certain,
    // so equal entries share a rank rather than being split arbitrarily.
    getRanking(): CoinRankingModel[] {
        const sorted = [...this.players].sort((a, b) => compareForRank(a, b));

        const ranking: CoinRankingModel[] = [];
        sorted.forEach((p, index) => {
            const previous = sorted[index - 1];
            const tied = previous !== undefined && compareForRank(previous, p) === 0;
            ranking.push({
                rank: tied ? ranking[index - 1].rank : index + 1,
                id: p.id,
                name: p.name,
                wallet: p.wallet,
                isAlive: p.isAlive,
                isDisconnected: p.isDisconnected,
            });
        });
        return ranking;
    }

    // The end screen reveals every player's final tile, not just the winner's
    // (§11).
    getFinalPositions(): { playerId: string; x: number; y: number }[] {
        return this.players
            .filter(p => p.hasPositioned && p.x !== null && p.y !== null)
            .map(p => ({ playerId: p.id, x: p.x as number, y: p.y as number }));
    }

    // ==========================================
    // LOGS
    // ==========================================

    addLog(type: CoinLogActionType, data: any): CoinActionLog {
        const now = Date.now();
        const newLog: CoinActionLog = {
            id: `log-${now}-${this.logIdCounter++}`,
            type,
            timestamp: now,
            data,
        };
        this.roundLogs.push(newLog);
        return newLog;
    }

    logPlayerDisconnected(playerId: string, playerName: string): RoomActionLog {
        return this.addLog('PLAYER_DISCONNECTED', { playerId, playerName } as PlayerDisconnectedData);
    }

    // ==========================================
    // RESET (§9)
    // ==========================================

    // Wallets return to the starting stake, piles re-roll, the laser schedule
    // resets. Host settings deliberately survive.
    resetGame(): void {
        this.state = 'lobby';
        this.players.forEach(p => p.fullReset());
        this.piles = this.rollPiles();
        this.destroyedTiles = [];
        this.roundNumber = 0;
        this.resolveCounter = 0;
        this.deathCounter = 0;
        this.roundLogs = [];
        this.logIdCounter = 0;
    }
}

// Negative when `a` outranks `b`, 0 when they are genuinely tied.
function compareForRank(a: CoinPlayerEntity, b: CoinPlayerEntity): number {
    if (a.wallet !== b.wallet) return b.wallet - a.wallet;
    if (a.isAlive !== b.isAlive) return a.isAlive ? -1 : 1;
    if (!a.isAlive && !b.isAlive) return (b.deathOrder ?? 0) - (a.deathOrder ?? 0);
    return 0;
}

function inRange(value: number, range: { min: number; max: number }): boolean {
    return Number.isInteger(value) && value >= range.min && value <= range.max;
}

// Compile-time proof that the engine still satisfies what the room layer needs.
// If a future edit breaks the contract this fails here rather than at a call
// site in RoomService.
const _contract: RoomEngine = null as unknown as CoinModeEngine;
void _contract;

export default CoinModeEngine;
