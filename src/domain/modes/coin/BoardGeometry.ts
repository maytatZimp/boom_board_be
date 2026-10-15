export type Coordinate = { x: number; y: number };

// Pure board math for coin mode. Kept out of `Board` so that adding to it can
// never change how simple mode behaves.

export function chebyshev(a: Coordinate, b: Coordinate): number {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

// Which ring a tile sits on, counting inward from the edge. On 8x8: ring 0 is
// the outer 28 tiles, then 20, then 12, and ring 3 is the centre 2x2.
export function ringIndex(x: number, y: number, width: number, height: number): number {
    return Math.min(x, y, width - 1 - x, height - 1 - y);
}

export function ringTiles(ring: number, width: number, height: number): Coordinate[] {
    const tiles: Coordinate[] = [];
    for (let x = 0; x < width; x++) {
        for (let y = 0; y < height; y++) {
            if (ringIndex(x, y, width, height) === ring) tiles.push({ x, y });
        }
    }
    return tiles;
}

export function isOnBoard(x: number, y: number, width: number, height: number): boolean {
    return x >= 0 && x < width && y >= 0 && y < height;
}

// The 8 surrounding tiles, clipped at the edges. This is the adjacency a coin
// pile pays out over and the adjacency a Move may cross.
export function neighbours8(x: number, y: number, width: number, height: number): Coordinate[] {
    const tiles: Coordinate[] = [];
    for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (isOnBoard(nx, ny, width, height)) tiles.push({ x: nx, y: ny });
        }
    }
    return tiles;
}

// The 4 orthogonal tiles -- a Big Bomb's arms, which clip harmlessly at edges.
export function neighboursCardinal(x: number, y: number, width: number, height: number): Coordinate[] {
    return [
        { x: x + 1, y },
        { x: x - 1, y },
        { x, y: y + 1 },
        { x, y: y - 1 },
    ].filter(t => isOnBoard(t.x, t.y, width, height));
}

export function isAdjacent8(a: Coordinate, b: Coordinate): boolean {
    if (a.x === b.x && a.y === b.y) return false;
    return chebyshev(a, b) === 1;
}

export function sameTile(a: Coordinate, b: Coordinate): boolean {
    return a.x === b.x && a.y === b.y;
}

// Scatters `count` piles off the outermost ring, no two within `minSpacing`
// Chebyshev of each other (§3).
//
// An earlier rule kept piles off the outer *two* rings; on 8x8 that leaves only
// the central 4x4, where the spacing constraint has essentially one solution and
// every game looks identical.
//
// Greedy placement from a shuffled candidate list can paint itself into a
// corner, so the whole placement is retried rather than backtracked. The
// fallback drops the spacing rule rather than returning fewer piles -- a board
// with 2 piles is a different game, a board with 2 piles close together is only
// a worse one.
export function placePiles(
    count: number,
    minSpacing: number,
    width: number,
    height: number,
): Coordinate[] {
    const candidates = [];
    for (let x = 0; x < width; x++) {
        for (let y = 0; y < height; y++) {
            if (ringIndex(x, y, width, height) > 0) candidates.push({ x, y });
        }
    }

    for (let attempt = 0; attempt < 50; attempt++) {
        const pool = shuffled(candidates);
        const chosen: Coordinate[] = [];

        for (const tile of pool) {
            if (chosen.every(p => chebyshev(p, tile) >= minSpacing)) {
                chosen.push(tile);
                if (chosen.length === count) return chosen;
            }
        }
    }

    return shuffled(candidates).slice(0, count);
}

function shuffled<T>(items: T[]): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
}
