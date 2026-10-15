// Every number coin mode can be tuned by, in one place. The ruleset's §14
// ("Balance dials -- expect to turn these") is the list we expect to revisit
// after playtesting; the rest are structural and changing them changes the game
// rather than its balance.

// --- Wallet and collecting -------------------------------------------------
export const START_WALLET = 3;
export const COLLECT_ON_PILE = 3;
export const COLLECT_ADJACENT = 2;
export const COLLECT_BASE = 1;

// --- Coin piles ------------------------------------------------------------
export const PILE_COUNT = 3;
// Pairwise Chebyshev distance between piles. 8-way adjacency means each pile
// blankets 9 tiles, so anything below 3 lets two piles share neighbours.
export const PILE_MIN_SPACING = 3;

// --- Phases ----------------------------------------------------------------
// Code constants, not host settings: a 10s timer in a 20-player room produces
// nothing but timeouts (§2).
export const ACTION_PHASE_SECONDS = 15;
export const ATTACK_PHASE_SECONDS = 30;

// --- Laser -----------------------------------------------------------------
// The laser closes rings 0, 1 and 2 and then stops, leaving the centre 2x2 as
// permanent board (§5.6). Burning the last ring would empty the board and end
// every game on the <=1-alive check at a fixed round, making the round limit
// unreachable.
export const LASER_RINGS_BURNED = 3;

// --- Host settings ---------------------------------------------------------
export interface CoinModeSettings {
    coinTarget: number;
    roundLimit: number;
    // null = the laser never fires and the board never shrinks.
    laserStartRound: number | null;
}

export const DEFAULT_SETTINGS: CoinModeSettings = {
    coinTarget: 15,
    roundLimit: 10,
    laserStartRound: 4,
};

export const SETTING_RANGES = {
    coinTarget: { min: 5, max: 50 },
    roundLimit: { min: 3, max: 30 },
    laserStartRound: { min: 1, max: 30 },
} as const;

// --- Shop ------------------------------------------------------------------
export const ITEM_COSTS = {
    shield: 3,
    teleporter: 2,
    tripleBomb: 1,
    bigBomb: 2,
    superHack: 2,
    doubleHack: 2,
} as const;

export const TRIPLE_BOMB_TARGETS = 3;
export const HACK_TARGETS = 3;
export const HACK_TARGETS_DOUBLED = 6;
export const HACK_STEAL = 1;
export const HACK_STEAL_SUPER = 2;

// --- Animation pacing (§15) ------------------------------------------------
// Bombs detonate one at a time in resolve order -- that beat is how a player
// reads who died to whom -- but the beat shortens as the round gets busier, so
// 20 bombers cost 12s rather than 30s. Server and client both derive their
// timings from the `stepMs` the server computes here.
export const DEFAULT_STEP_MS = 1500;
export const MIN_STEP_MS = 400;
export const MAX_ROUND_ANIM_MS = 12000;
export const LASER_ANIM_MS = 1000;
export const ROUND_ANIM_BUFFER_MS = 300;

// The numbers a client needs in order to label a button correctly: what a
// Collect will pay here, how many tiles a hack names, what an item costs.
//
// They are sent rather than hand-copied into the Flutter client because M4
// exists to turn them. The server stays authoritative about every rule; this
// is only so the UI does not advertise last week's prices.
export interface CoinDials {
    collectOnPile: number;
    collectAdjacent: number;
    collectBase: number;
    hackTargets: number;
    hackTargetsDoubled: number;
    tripleBombTargets: number;
    itemCosts: Record<string, number>;
}

export const COIN_DIALS: CoinDials = {
    collectOnPile: COLLECT_ON_PILE,
    collectAdjacent: COLLECT_ADJACENT,
    collectBase: COLLECT_BASE,
    hackTargets: HACK_TARGETS,
    hackTargetsDoubled: HACK_TARGETS_DOUBLED,
    tripleBombTargets: TRIPLE_BOMB_TARGETS,
    itemCosts: { ...ITEM_COSTS },
};

export function bombStepMs(bombCount: number): number {
    if (bombCount <= 0) return DEFAULT_STEP_MS;
    const scaled = MAX_ROUND_ANIM_MS / bombCount;
    return Math.round(Math.min(DEFAULT_STEP_MS, Math.max(MIN_STEP_MS, scaled)));
}
