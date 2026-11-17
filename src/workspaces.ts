import * as fs from 'fs';
import * as path from 'path';
import { contentSignature } from './sqliteSnapshot';

export interface WorkspaceIdentity { workspaceKey: string; workspaceLabel: string; folders: string[]; }

/** Normalize Windows paths even when inspecting their fixtures on another OS. */
export function normalizeWorkspacePath(value: string): string {
    let result = value.trim();
    if (/^file:/i.test(result)) {
        try {
            const uri = new URL(result);
            result = `${uri.hostname && uri.hostname !== 'localhost' ? `//${uri.hostname}` : ''}${decodeURIComponent(uri.pathname)}`;
            if (/^\/[a-z]:/i.test(result)) { result = result.slice(1); }
        } catch { return ''; }
    } else if (/^[a-z][\w+.-]*:\/\//i.test(result)) {
        // Remote authorities are distinct from local folders and from one another.
        try { const uri = new URL(result); return `${uri.protocol}//${uri.host}${decodeURIComponent(uri.pathname).replace(/\/+$/, '')}`; } catch { return ''; }
    }
    const windows = /^[a-z]:[\\/]/i.test(result) || /^\\\\|^\/\//.test(result);
    result = windows ? path.win32.normalize(result).replace(/\\/g, '/').toLowerCase() : path.posix.normalize(result);
    return result.replace(/\/+$/, '') || '/';
}

export function workspacePathLabel(value: string): string {
    let decoded = value; try { decoded = decodeURIComponent(value); } catch {}
    return decoded.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop()?.replace(/\.code-workspace$/i, '') || 'Unknown workspace';
}

// Workspace files allow comments and trailing commas. Strip only outside strings.
function parseJsonc(text: string): any {
    let clean = '', quoted = false, escaped = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i], next = text[i + 1];
        if (!quoted && c === '/' && next === '/') { while (i < text.length && text[i] !== '\n') { i++; } clean += '\n'; continue; }
        if (!quoted && c === '/' && next === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) { i++; } i++; clean += ' '; continue; }
        if (!quoted && c === ',' && /^\s*[}\]]/.test(text.slice(i + 1))) { continue; }
        clean += c;
        if (c === '"' && !escaped) { quoted = !quoted; }
        escaped = quoted && c === '\\' && !escaped;
    }
    // A comma before a removed comment also needs a second, string-aware pass.
    if (clean !== text) { return parseJsonc(clean); }
    return JSON.parse(clean);
}

const cache = new Map<string, { signature: string; workspaceFile?: string; value: WorkspaceIdentity }>();
const signatureOf = (file: string) => { try { return contentSignature(file); } catch { return 'unreadable'; } };

export function readWorkspaceIdentity(storageDir: string): WorkspaceIdentity {
    const file = path.join(storageDir, 'workspace.json');
    const saved = cache.get(storageDir);
    if (saved && saved.signature === `${signatureOf(file)}|${saved.workspaceFile ? signatureOf(saved.workspaceFile) : ''}`) { return saved.value; }
    let metadata: any;
    try { metadata = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { metadata = {}; }
    const workspaceFile = typeof metadata.workspace === 'string' ? normalizeWorkspacePath(metadata.workspace) : undefined;
    const signature = `${signatureOf(file)}|${workspaceFile ? signatureOf(workspaceFile) : ''}`;
    const folders: string[] = [];
    let label: string | undefined;
    if (typeof metadata.folder === 'string') { folders.push(normalizeWorkspacePath(metadata.folder)); label = workspacePathLabel(metadata.folder); }
    if (workspaceFile) {
        try {
            const workspace = parseJsonc(fs.readFileSync(workspaceFile, 'utf8'));
            const labels: string[] = [];
            for (const folder of workspace.folders ?? []) {
                const raw = folder.uri ?? folder.path;
                if (typeof raw !== 'string') { continue; }
                const api = /^[a-z]:/i.test(workspaceFile) ? path.win32 : path;
                const absolute = /^[a-z][\w+.-]*:/i.test(raw) || api.isAbsolute(raw) ? raw : api.resolve(api.dirname(workspaceFile), raw);
                folders.push(normalizeWorkspacePath(absolute)); labels.push(folder.name || workspacePathLabel(absolute));
            }
            if (labels.length) { label = labels[0] + (labels.length > 1 ? ` +${labels.length - 1}` : ''); }
        } catch { /* Missing or remote workspace files retain a stable workspace-file identity. */ }
        label ??= workspacePathLabel(workspaceFile);
    }
    const value = { workspaceKey: normalizeWorkspacePath(storageDir), workspaceLabel: label || path.basename(storageDir).slice(0, 8) || 'Unknown workspace', folders: folders.filter(Boolean) };
    cache.set(storageDir, { signature, workspaceFile, value });
    return value;
}

export class WorkspaceIndex {
    private readonly entries: WorkspaceIdentity[];
    constructor(storageDirs: string[]) {
        const dirs = new Set(storageDirs);
        // Include workspaces without chat history yet, using only known workspaceStorage parents.
        for (const parent of new Set(storageDirs.map(path.dirname))) {
            if (path.basename(parent) !== 'workspaceStorage') { continue; }
            try { for (const e of fs.readdirSync(parent, { withFileTypes: true })) { if (e.isDirectory()) { dirs.add(path.join(parent, e.name)); } } } catch {}
        }
        this.entries = [...dirs].sort().map(readWorkspaceIdentity);
    }
    resolve(cwd?: string, additional: string[] = [], workspaceless = false): Omit<WorkspaceIdentity, 'folders'> {
        if (workspaceless) { return { workspaceKey: 'agent:workspaceless', workspaceLabel: 'No workspace' }; }
        const folders = [...new Set([cwd, ...additional].filter((x): x is string => !!x).map(normalizeWorkspacePath).filter(Boolean))];
        if (!folders.length) { return { workspaceKey: 'agent:unknown-workspace', workspaceLabel: 'Unknown workspace' }; }
        const matches = this.entries.map(e => ({ e, prefix: e.folders.filter(root => folders[0] === root || folders[0].startsWith(root.endsWith('/') ? root : `${root}/`)).sort((a,b)=>b.length-a.length)[0] }))
            .filter(m => !!m.prefix).sort((a,b) => b.prefix.length - a.prefix.length || Number(b.e.folders.length === folders.length && folders.every(f => b.e.folders.includes(f))) - Number(a.e.folders.length === folders.length && folders.every(f => a.e.folders.includes(f))));
        const match = matches[0]?.e;
        return match ? { workspaceKey: match.workspaceKey, workspaceLabel: match.workspaceLabel }
            : { workspaceKey: `folder:${folders.join('|')}`, workspaceLabel: workspacePathLabel(cwd || folders[0]) + (folders.length > 1 ? ` +${folders.length - 1}` : '') };
    }
}

const eventContexts = new Map<string, { identity: string; bytes: number; cwd?: string; complete: boolean }>();
/** Session context lives in the head; unchanged logs need no file reads. */
export function readEventWorkspace(file?: string): string | undefined {
    if (!file) { return undefined; }
    try {
        const stat = fs.statSync(file, { bigint: true });
        const identity = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
        const size = Number(stat.size), saved = eventContexts.get(file);
        if (saved?.identity === identity && size >= saved.bytes && saved.complete) { return saved.cwd; }
        const fd = fs.openSync(file, 'r'); let bytes: number; const buffer = Buffer.alloc(Math.min(size, 64 * 1024));
        try { bytes = fs.readSync(fd, buffer, 0, buffer.length, 0); } finally { fs.closeSync(fd); }
        const text = buffer.subarray(0, bytes).toString('utf8');
        let cwd: string | undefined;
        for (const line of text.split('\n')) { try { const e = JSON.parse(line); if (e.type === 'session.start' && typeof e.data?.context?.cwd === 'string') { cwd = e.data.context.cwd; break; } } catch {} }
        eventContexts.set(file, { identity, bytes, cwd, complete: !!cwd || bytes === 64 * 1024 });
        return cwd;
    } catch { return undefined; }
}
