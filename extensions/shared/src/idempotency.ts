/**
 * Keeps one Idempotency-Key per logical user action (15.5, "Envois sûrs"): a submission retried after a
 * network cut or an error with the same payload reuses the key, so the server cannot apply it twice;
 * a different payload, or a success, starts a new key.
 */
export class IdempotencyKeeper {
  private last: { fingerprint: string; key: string } | null = null;
  constructor(private readonly newKey: () => string = () => globalThis.crypto.randomUUID()) {}

  keyFor(payload: unknown): string {
    const fingerprint = JSON.stringify(payload);
    if (this.last && this.last.fingerprint === fingerprint) return this.last.key;
    this.last = { fingerprint, key: this.newKey() };
    return this.last.key;
  }

  /** Call after a successful (or definitively answered) submission. */
  done(): void {
    this.last = null;
  }
}
