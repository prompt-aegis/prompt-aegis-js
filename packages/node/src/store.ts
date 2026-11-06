/** Storage for clients flagged by honeypot hits. Implement with Redis etc. for clusters. */
export interface FlagStore {
  has(key: string): boolean | Promise<boolean>;
  set(key: string, ttlMs: number): void | Promise<void>;
  delete?(key: string): void | Promise<void>;
}

/** In-process store with TTL and a size cap (oldest entries evicted first). */
export class MemoryFlagStore implements FlagStore {
  private readonly map = new Map<string, number>();
  constructor(private readonly maxEntries = 50_000) {}

  has(key: string): boolean {
    const exp = this.map.get(key);
    if (exp === undefined) return false;
    if (exp < Date.now()) {
      this.map.delete(key);
      return false;
    }
    return true;
  }

  set(key: string, ttlMs: number): void {
    this.map.delete(key);
    this.map.set(key, Date.now() + ttlMs);
    if (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }
}
