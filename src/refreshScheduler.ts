interface RefreshClock {
    now(): number;
    setTimeout(callback: () => void, delay: number): unknown;
    clearTimeout(timer: unknown): void;
}
const systemClock: RefreshClock = {
    now: () => Date.now(),
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: timer => clearTimeout(timer as NodeJS.Timeout),
};

/** Coalesce writes without waiting for the log to go quiet or overlapping scans. */
export class RefreshScheduler {
    private timer: unknown;
    private running = false;
    private pending = false;
    private immediate = false;
    private disposed = false;
    private nextAllowed: number;

    constructor(
        private intervalMs: number,
        private refresh: () => Promise<void>,
        private onError: (error: unknown) => void,
        private clock: RefreshClock = systemClock,
    ) {
        this.nextAllowed = clock.now() + intervalMs;
    }

    request(immediate = false): void {
        if (this.disposed) { return; }
        this.pending = true;
        this.immediate ||= immediate;
        // New automatic events keep the existing deadline; they cannot starve a refresh.
        if (this.timer !== undefined && immediate) {
            this.clock.clearTimeout(this.timer);
            this.timer = undefined;
        }
        this.schedule();
    }

    private schedule(): void {
        if (this.disposed || this.running || this.timer !== undefined || !this.pending) { return; }
        const delay = this.immediate ? 0 : Math.max(0, this.nextAllowed - this.clock.now());
        this.timer = this.clock.setTimeout(() => { void this.run(); }, delay);
    }

    private async run(): Promise<void> {
        this.timer = undefined;
        if (this.disposed) { return; }
        this.running = true;
        this.pending = false;
        this.immediate = false;
        this.nextAllowed = this.clock.now() + this.intervalMs;
        try { await this.refresh(); }
        catch (error) { if (!this.disposed) { this.onError(error); } }
        finally {
            this.running = false;
            this.schedule();
        }
    }

    dispose(): void {
        this.disposed = true;
        if (this.timer !== undefined) { this.clock.clearTimeout(this.timer); }
        this.timer = undefined;
        this.pending = false;
    }
}
