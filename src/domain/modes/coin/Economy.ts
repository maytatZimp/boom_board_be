import { COLLECT_ADJACENT, COLLECT_BASE, COLLECT_ON_PILE } from './constants';
import { Coordinate, isAdjacent8, sameTile } from './BoardGeometry';

// Half a wallet, rounded down. The same bite twice over, deliberately: a kill
// hands it to the killer (§9), the laser destroys it and nobody collects
// (§5.6). Keeping one function makes it obvious they are meant to hurt equally.
export function halfWallet(wallet: number): number {
    return Math.floor(wallet / 2);
}

// A hack takes what is there and no more -- a Super Hack against a victim
// holding 1 coin takes the 1 (§7.2).
export function stealable(wallet: number, attempted: number): number {
    return Math.min(attempted, Math.max(0, wallet));
}

// What a Collect pays at this tile (§6). Scored against post-move positions,
// because moves resolve first.
//
// `piles` includes burned piles: a pile whose own tile the laser destroyed
// still pays the adjacent rate to its neighbours, and nobody can be standing on
// it to claim the on-pile rate anyway.
export function collectRate(tile: Coordinate, piles: Coordinate[]): number {
    if (piles.some(p => sameTile(p, tile))) return COLLECT_ON_PILE;
    if (piles.some(p => isAdjacent8(p, tile))) return COLLECT_ADJACENT;
    return COLLECT_BASE;
}
