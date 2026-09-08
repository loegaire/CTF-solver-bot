/**
 * Minimal leveled logger. Everything goes to stdout/stderr and is captured by journald.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let currentLevel: number = LEVELS.info;

export function setLogLevel(level: Level): void {
    currentLevel = LEVELS[level] ?? LEVELS.info;
}

function fmt(tag: string, args: unknown[]): string {
    const parts = args.map((a) => (typeof a === 'string' ? a : utilInspect(a)));
    return `[${tag}] ${parts.join(' ')}`;
}

function utilInspect(a: unknown): string {
    try {
        return a instanceof Error ? (a.stack ?? String(a)) : JSON.stringify(a);
    } catch {
        return String(a);
    }
}

function emit(level: Level, stream: NodeJS.WriteStream, tag: string, args: unknown[]): void {
    if (LEVELS[level] < currentLevel) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${fmt(tag, args)}`;
    stream.write(line + '\n');
}

export const log = {
    debug: (tag: string, ...args: unknown[]) => emit('debug', process.stdout, tag, args),
    info: (tag: string, ...args: unknown[]) => emit('info', process.stdout, tag, args),
    warn: (tag: string, ...args: unknown[]) => emit('warn', process.stderr, tag, args),
    error: (tag: string, ...args: unknown[]) => emit('error', process.stderr, tag, args),
};
