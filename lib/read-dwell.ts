/** One cancellable dwell per session/view. Losing eligibility restarts the clock. */
export class ReadDwell {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private key: string | null = null;
  constructor(private readonly commit: (key: string) => void, private readonly eligible: () => boolean) {}
  update(key: string | null): void {
    if (key === this.key) return;
    this.cancel();
    this.key = key;
    if (key === null) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.eligible()) this.commit(key);
      this.key = null;
    }, 500);
  }
  cancel(): void { if (this.timer !== undefined) clearTimeout(this.timer); this.timer = undefined; this.key = null; }
}
