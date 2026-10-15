import { Coordinate } from '../modes/coin/BoardGeometry';
import { START_WALLET } from '../modes/coin/constants';

export type CoinActionType = 'move' | 'collect';
export type BombUpgrade = 'triple' | 'big' | null;

export interface PendingAction {
    type: CoinActionType;
    // Present only for a move. Normally an adjacent tile; any non-destroyed
    // tile when a Teleporter is armed.
    target?: Coordinate;
}

class CoinPlayerEntity {
    id: string;
    name: string;
    // Private credential. Never leaves the server except in the one create/join
    // ack to the socket that owns it -- keep it out of every roster payload.
    secret: string;

    // Simultaneously spending money and score (ADR-0002). There is no separate
    // score, so every purchase is paid for out of the thing that decides the
    // winner. Private and live: only its owner ever sees this value.
    wallet: number;

    // What everyone else is told this wallet holds, refreshed once at the end
    // of each round (§5.7). The gap between this and `wallet` is load-bearing:
    // the round-over-round delta in the public total is the whole anti-camping
    // read, and publishing mid-round -- on a kill, a hack, or a roster
    // broadcast after someone drops -- would make the read instant and
    // unescapable. Every public roster payload reads this, never `wallet`.
    publicWallet: number;

    isAlive: boolean;
    deathOrder: number | null;
    isDisconnected: boolean;

    x: number | null;
    y: number | null;
    hasPositioned: boolean;

    // --- Action phase ---
    pendingAction: PendingAction | null;

    // --- Attack phase ---
    // One tile normally, three distinct ones with a Triple Bomb. A living
    // player fills this; a dead player fills `hackTargets` instead.
    bombTargets: Coordinate[] | null;
    // Three tiles, six with a Double Hack. Duplicates are legal and pay each
    // time -- that is what lets a dead player's threat exceed a living player's
    // cost of fleeing (§7.2).
    hackTargets: Coordinate[] | null;
    // One counter shared by bombs and hacks, so hackers and bombers compete
    // over the same wallets (§5.4).
    resolveOrder: number | null;

    // --- Items ---
    // The only item that outlives its round: it persists until a bomb consumes
    // it, and you may hold just one.
    hasShield: boolean;
    teleporterArmed: boolean;
    bombUpgrade: BombUpgrade;
    hasSuperHack: boolean;
    hasDoubleHack: boolean;
    // The living one-item-per-round cap (§8), which is what forces the choice
    // between arming and protecting yourself. Dead players are exempt and so
    // never consult this.
    boughtThisRound: boolean;

    constructor(id: string, name: string, secret: string) {
        this.id = id;
        this.name = name;
        this.secret = secret;
        this.wallet = START_WALLET;
        this.publicWallet = START_WALLET;

        this.isAlive = true;
        this.deathOrder = null;
        this.isDisconnected = false;

        this.x = null;
        this.y = null;
        this.hasPositioned = false;

        this.pendingAction = null;
        this.bombTargets = null;
        this.hackTargets = null;
        this.resolveOrder = null;

        this.hasShield = false;
        this.teleporterArmed = false;
        this.bombUpgrade = null;
        this.hasSuperHack = false;
        this.hasDoubleHack = false;
        this.boughtThisRound = false;
    }

    setPosition(x: number, y: number): void {
        this.x = x;
        this.y = y;
        this.hasPositioned = true;
    }

    setAction(action: PendingAction): void {
        this.pendingAction = action;
    }

    setBombTargets(targets: Coordinate[], order: number): void {
        this.bombTargets = targets;
        this.resolveOrder = order;
    }

    setHackTargets(targets: Coordinate[], order: number): void {
        this.hackTargets = targets;
        this.resolveOrder = order;
    }

    earn(amount: number): void {
        this.wallet += amount;
    }

    // Returns what was actually taken, which may be less than asked for.
    take(amount: number): number {
        const taken = Math.min(amount, this.wallet);
        this.wallet -= taken;
        return taken;
    }

    spend(amount: number): boolean {
        if (amount > this.wallet) return false;
        this.wallet -= amount;
        return true;
    }

    // Called once per round, after every bomb, hack and laser has resolved.
    publishWallet(): void {
        this.publicWallet = this.wallet;
    }

    consumeShield(): void {
        this.hasShield = false;
    }

    eliminate(order: number): void {
        this.isAlive = false;
        this.deathOrder = order;
    }

    // Life status and connection status are orthogonal: losing your client does
    // not take you off the board, and dying does not detach your client. A
    // disconnected living player keeps collecting at whatever tile they are on
    // (§12), which is why this deliberately never touches `isAlive`.
    setDisconnected(flag: boolean): void {
        this.isDisconnected = flag;
    }

    setName(name: string): void {
        this.name = name;
    }

    // Between rounds. Keeps the wallet, the tile, life status -- and the
    // shield, which is the one item that persists until consumed.
    resetRound(): void {
        this.pendingAction = null;
        this.bombTargets = null;
        this.hackTargets = null;
        this.resolveOrder = null;
        this.teleporterArmed = false;
        this.bombUpgrade = null;
        this.hasSuperHack = false;
        this.hasDoubleHack = false;
        this.boughtThisRound = false;
    }

    // Back to the lobby for a fresh game: wallets return to the starting stake
    // and every item is gone (§9).
    fullReset(): void {
        this.wallet = START_WALLET;
        this.publicWallet = START_WALLET;
        this.isAlive = true;
        this.deathOrder = null;
        this.isDisconnected = false;
        this.x = null;
        this.y = null;
        this.hasPositioned = false;
        this.hasShield = false;
        this.resetRound();
    }
}

export default CoinPlayerEntity;
