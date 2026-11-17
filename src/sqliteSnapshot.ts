import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Stable cache identity across drive-letter and directory case variations on Windows. */
export function filePathKey(file: string, platform = process.platform): string {
    const resolved = platform === 'win32' ? path.win32.resolve(file) : path.resolve(file);
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** ctime changes on permissions and SQLite reader bookkeeping, not just content. */
export function contentSignature(file: string): string {
    try {
        const s = fs.statSync(file, { bigint: true });
        return `${s.ino}:${s.size}:${s.mtimeNs}`;
    } catch (error) {
        if (error.code === 'ENOENT') { return 'missing'; }
        throw error;
    }
}

export function databaseSignature(file: string): string {
    return [file, `${file}-wal`, `${file}-journal`].map(contentSignature).join('|');
}

/** SQLite may update -shm/-wal even with readOnly. WAL databases use a private copy.
 * Include WAL to retain committed, uncheckpointed turns. Retry a concurrent write,
 * and reject rollback journals rather than reading an uncommitted main database.
 */
export function withDatabaseSnapshot<T>(file: string, read: (db: any) => T): T {
    const { DatabaseSync } = require('node:sqlite');
    // Only rollback-mode files without sidecars are safe to open directly.
    // A WAL-mode header still requires a snapshot even when its WAL is currently empty.
    const beforeDirect = databaseSignature(file);
    const header = Buffer.alloc(20), fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, header, 0, header.length, 0); } finally { fs.closeSync(fd); }
    if (header[18] === 1 && header[19] === 1 && !['-wal','-shm','-journal'].some(s => fs.existsSync(file+s))) {
        try {
            const db = new DatabaseSync(file, { readOnly: true });
            let result: T;
            try { result = read(db); } finally { db.close(); }
            if (beforeDirect === databaseSignature(file)) { return result; }
        } catch (error) {
            if (!/busy|locked/i.test(String(error))) { throw error; }
        }
        // A concurrent mode switch/write is retried using the stable-copy path below.
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-usage-'));
    fs.chmodSync(dir, 0o700);
    const copy = path.join(dir, 'session.db');
    try {
        for (let attempt = 0; attempt < 3; attempt++) {
            const before = databaseSignature(file);
            if (fs.existsSync(`${file}-journal`) && fs.statSync(`${file}-journal`).size > 0) {
                throw new Error('Agent database has an active rollback journal; retry later.');
            }
            fs.copyFileSync(file, copy);
            try { fs.copyFileSync(`${file}-wal`, `${copy}-wal`); }
            catch (error) {
                if (error.code !== 'ENOENT') { throw error; }
                fs.rmSync(`${copy}-wal`, { force: true });
            }
            if (before !== databaseSignature(file)) { continue; }
            const db = new DatabaseSync(copy, { readOnly: true });
            try { return read(db); } finally { db.close(); }
        }
        throw new Error('Agent database changed during snapshot; retry later.');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
