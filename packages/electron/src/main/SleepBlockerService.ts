export type PowerSaveBlockerType =
  | "prevent-app-suspension"
  | "prevent-display-sleep";

export interface PowerSaveBlockerAdapter {
  start(type: PowerSaveBlockerType): number;
  stop(id: number): boolean;
  isStarted(id: number): boolean;
}

export class SleepBlockerService {
  private blockerId: number | null = null;
  private enabled = true;
  private activeReasons = new Set<string>();

  constructor(
    private readonly powerSaveBlocker: PowerSaveBlockerAdapter,
    private readonly blockerType: PowerSaveBlockerType =
      "prevent-app-suspension",
    private readonly logger: Pick<Console, "warn"> = console,
  ) {}

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.sync();
  }

  setReasonActive(reason: string, active: boolean): void {
    const normalizedReason = reason.trim();
    if (!normalizedReason) return;

    if (active) {
      this.activeReasons.add(normalizedReason);
    } else {
      this.activeReasons.delete(normalizedReason);
    }
    this.sync();
  }

  isBlocking(): boolean {
    return this.blockerId !== null;
  }

  dispose(): void {
    this.activeReasons.clear();
    this.stopBlocker();
  }

  private sync(): void {
    const shouldBlock = this.enabled && this.activeReasons.size > 0;
    if (shouldBlock) {
      this.startBlocker();
    } else {
      this.stopBlocker();
    }
  }

  private startBlocker(): void {
    if (this.blockerId !== null) return;
    try {
      this.blockerId = this.powerSaveBlocker.start(this.blockerType);
    } catch (error) {
      this.blockerId = null;
      this.logger.warn("[SleepBlockerService] Failed to start blocker:", error);
    }
  }

  private stopBlocker(): void {
    if (this.blockerId === null) return;
    const blockerId = this.blockerId;
    this.blockerId = null;
    try {
      if (this.powerSaveBlocker.isStarted(blockerId)) {
        this.powerSaveBlocker.stop(blockerId);
      }
    } catch (error) {
      this.logger.warn("[SleepBlockerService] Failed to stop blocker:", error);
    }
  }
}
