import { GameMode } from './RoomStore';

// The room code carries its own mode, as a leading character.
//
// It is read aloud and typed by hand in a party game, so the mode goes first:
// a leading character is easy to say ("C, then A-B-C-D"), easy to spot in a
// chat message, and cannot be mistaken for part of the random tail.
//
// This makes the code a parsed structure rather than an opaque handle, and the
// mapping below is duplicated by hand in the Flutter client
// (`GameMode.prefix` / `GameMode.fromRoomCode`). Adding a mode means editing
// both, exactly like a socket payload.
//
// What it buys: a client knows which mode it is entering *before* it asks the
// server, so it can bind that mode's socket handlers up front rather than
// binding every mode and dropping the losers once the ack reveals the answer.
export const MODE_PREFIX: Record<GameMode, string> = {
    simple: 'S',
    coin: 'C',
};

const RANDOM_LENGTH = 4;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

// The prefix is authoritative only as far as the client's optimism goes: the
// server still answers from `room.gameMode`, and a code naming a mode the room
// does not have simply fails to find a room at all.
export function modeFromRoomCode(roomCode: string): GameMode | undefined {
    const prefix = roomCode.trim().toUpperCase().charAt(0);
    const entry = (Object.entries(MODE_PREFIX) as [GameMode, string][])
        .find(([, modePrefix]) => modePrefix === prefix);
    return entry?.[0];
}

export function isValidRoomCode(roomCode: string): boolean {
    const code = roomCode.trim().toUpperCase();
    if (code.length !== RANDOM_LENGTH + 1) return false;
    if (!modeFromRoomCode(code)) return false;
    return [...code.slice(1)].every(character => ALPHABET.includes(character));
}

export function generateRoomCode(mode: GameMode, isTaken: (code: string) => boolean): string {
    let code = '';
    do {
        // Drawn character by character from an explicit alphabet rather than
        // sliced out of `Math.random().toString(36)`, which yields a short
        // string whenever the random number has few digits. That was harmless
        // while the code was opaque; now that its length is part of the
        // contract a 3-character room would be permanently unjoinable.
        let tail = '';
        for (let i = 0; i < RANDOM_LENGTH; i++) {
            tail += ALPHABET.charAt(Math.floor(Math.random() * ALPHABET.length));
        }
        code = `${MODE_PREFIX[mode]}${tail}`;
    } while (isTaken(code));

    return code;
}
