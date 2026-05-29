export interface CredentialEntry {
  id: string;
  provider: string;
  key: string;
  active: boolean;
  lastUsedAt: number | null;
  useCount: number;
  errorCount: number;
  lastErrorAt: number | null;
  rateLimitedUntil: number | null;
  addedAt: number;
}

export interface CredentialPoolConfig {
  maxCredentialsPerProvider: number;
  rotationStrategy: "round-robin" | "random" | "least-used";
  rateLimitCooldownMs: number;
  maxErrorCount: number;
}

function generateId(): string {
  return `cred_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export class CredentialPool {
  private credentials = new Map<string, CredentialEntry[]>();
  private config: CredentialPoolConfig;
  private roundRobinIndex = new Map<string, number>();

  constructor(config?: Partial<CredentialPoolConfig>) {
    this.config = {
      maxCredentialsPerProvider: config?.maxCredentialsPerProvider ?? 5,
      rotationStrategy: config?.rotationStrategy ?? "round-robin",
      rateLimitCooldownMs: config?.rateLimitCooldownMs ?? 60000,
      maxErrorCount: config?.maxErrorCount ?? 5,
    };
  }

  addCredential(provider: string, key: string): string {
    const existing = this.credentials.get(provider) ?? [];
    if (existing.length >= this.config.maxCredentialsPerProvider) {
      throw new Error(
        `Maximum credentials (${this.config.maxCredentialsPerProvider}) reached for provider "${provider}"`
      );
    }

    const id = generateId();
    const entry: CredentialEntry = {
      id,
      provider,
      key,
      active: true,
      lastUsedAt: null,
      useCount: 0,
      errorCount: 0,
      lastErrorAt: null,
      rateLimitedUntil: null,
      addedAt: Date.now(),
    };

    existing.push(entry);
    this.credentials.set(provider, existing);
    return id;
  }

  removeCredential(id: string): boolean {
    for (const [provider, entries] of this.credentials) {
      const index = entries.findIndex((e) => e.id === id);
      if (index !== -1) {
        entries.splice(index, 1);
        if (entries.length === 0) {
          this.credentials.delete(provider);
          this.roundRobinIndex.delete(provider);
        }
        return true;
      }
    }
    return false;
  }

  getCredential(provider: string): CredentialEntry | null {
    const entries = this.credentials.get(provider);
    if (!entries || entries.length === 0) return null;

    const now = Date.now();
    const available = entries.filter(
      (e) =>
        e.active &&
        (e.rateLimitedUntil === null || e.rateLimitedUntil <= now)
    );

    if (available.length === 0) return null;

    switch (this.config.rotationStrategy) {
      case "round-robin": {
        const currentIndex = this.roundRobinIndex.get(provider) ?? 0;
        const selected = available[currentIndex % available.length];
        this.roundRobinIndex.set(provider, (currentIndex + 1) % available.length);
        selected.lastUsedAt = now;
        selected.useCount++;
        return selected;
      }
      case "random": {
        const selected = available[Math.floor(Math.random() * available.length)];
        selected.lastUsedAt = now;
        selected.useCount++;
        return selected;
      }
      case "least-used": {
        const sorted = [...available].sort((a, b) => a.useCount - b.useCount);
        const selected = sorted[0];
        selected.lastUsedAt = now;
        selected.useCount++;
        return selected;
      }
      default:
        return null;
    }
  }

  reportSuccess(id: string): void {
    const entry = this.findEntry(id);
    if (!entry) return;
    entry.errorCount = 0;
  }

  reportError(id: string, errorType: "rate_limit" | "auth" | "server" | "unknown"): void {
    const entry = this.findEntry(id);
    if (!entry) return;

    const now = Date.now();
    entry.errorCount++;
    entry.lastErrorAt = now;

    switch (errorType) {
      case "rate_limit":
        entry.rateLimitedUntil = now + this.config.rateLimitCooldownMs;
        break;
      case "auth":
        entry.active = false;
        break;
      case "server":
        if (entry.errorCount >= this.config.maxErrorCount) {
          entry.active = false;
        }
        break;
      case "unknown":
        if (entry.errorCount >= this.config.maxErrorCount) {
          entry.active = false;
        }
        break;
    }
  }

  getCredentials(provider: string): CredentialEntry[] {
    return [...(this.credentials.get(provider) ?? [])];
  }

  getAvailableCount(provider: string): number {
    const entries = this.credentials.get(provider);
    if (!entries) return 0;
    const now = Date.now();
    return entries.filter(
      (e) =>
        e.active &&
        (e.rateLimitedUntil === null || e.rateLimitedUntil <= now)
    ).length;
  }

  cleanupRateLimits(): void {
    const now = Date.now();
    for (const entries of this.credentials.values()) {
      for (const entry of entries) {
        if (entry.rateLimitedUntil !== null && entry.rateLimitedUntil <= now) {
          entry.rateLimitedUntil = null;
        }
      }
    }
  }

  getStats(): {
    totalCredentials: number;
    activeCredentials: number;
    rateLimitedCredentials: number;
    disabledCredentials: number;
  } {
    let totalCredentials = 0;
    let activeCredentials = 0;
    let rateLimitedCredentials = 0;
    let disabledCredentials = 0;
    const now = Date.now();

    for (const entries of this.credentials.values()) {
      for (const entry of entries) {
        totalCredentials++;
        if (!entry.active) {
          disabledCredentials++;
        } else if (entry.rateLimitedUntil !== null && entry.rateLimitedUntil > now) {
          rateLimitedCredentials++;
        } else {
          activeCredentials++;
        }
      }
    }

    return { totalCredentials, activeCredentials, rateLimitedCredentials, disabledCredentials };
  }

  private findEntry(id: string): CredentialEntry | undefined {
    for (const entries of this.credentials.values()) {
      const found = entries.find((e) => e.id === id);
      if (found) return found;
    }
    return undefined;
  }
}
