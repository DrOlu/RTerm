import { action, computed, makeObservable, observable } from "mobx";

/**
 * BroadcastStore — Terminator / iTerm2-style "broadcast input".
 *
 * A broadcast group is a set of terminal ids that should all receive the same
 * keystrokes. When broadcast mode is ON and a terminal in the group emits
 * input, XTermView calls fanOut() so the same data is written to every *other*
 * member (the originating terminal already wrote its own input to avoid a
 * double-send).
 *
 * Safety model:
 * - Broadcast is OFF by default and must be explicitly enabled.
 * - Membership is explicit (per-terminal opt-in via the tab context menu).
 * - Dead/closed terminals are pruned automatically on fan-out.
 * - A member can be individually paused without leaving the group.
 */
class BroadcastStore {
  /** Whether broadcast fan-out is active. */
  enabled = false;
  /** Terminal ids in the broadcast group. */
  memberIds = new Set<string>();
  /** Members that are in the group but temporarily not receiving input. */
  pausedIds = new Set<string>();

  constructor() {
    makeObservable(this, {
      enabled: observable,
      memberIds: observable,
      pausedIds: observable,
      activeMemberIds: computed,
      isMember: action,
      toggle: action,
      setEnabled: action,
      addMember: action,
      removeMember: action,
      toggleMember: action,
      setPaused: action,
      togglePaused: action,
      prune: action,
      clear: action,
    });
  }

  /** Members that are enabled, not paused — the actual fan-out targets. */
  get activeMemberIds(): string[] {
    if (!this.enabled) return [];
    return [...this.memberIds].filter((id) => !this.pausedIds.has(id));
  }

  isMember(terminalId: string): boolean {
    return this.memberIds.has(terminalId);
  }

  toggle(): void {
    this.enabled = !this.enabled;
  }

  setEnabled(next: boolean): void {
    this.enabled = next;
  }

  addMember(terminalId: string): void {
    this.memberIds.add(terminalId);
  }

  removeMember(terminalId: string): void {
    this.memberIds.delete(terminalId);
    this.pausedIds.delete(terminalId);
  }

  toggleMember(terminalId: string): void {
    if (this.memberIds.has(terminalId)) this.removeMember(terminalId);
    else this.addMember(terminalId);
  }

  setPaused(terminalId: string, paused: boolean): void {
    if (paused) this.pausedIds.add(terminalId);
    else this.pausedIds.delete(terminalId);
  }

  togglePaused(terminalId: string): void {
    this.setPaused(terminalId, !this.pausedIds.has(terminalId));
  }

  /** Drop members that no longer exist in the live terminal set. */
  prune(liveTerminalIds: Set<string>): void {
    for (const id of [...this.memberIds]) {
      if (!liveTerminalIds.has(id)) this.removeMember(id);
    }
  }

  clear(): void {
    this.memberIds.clear();
    this.pausedIds.clear();
    this.enabled = false;
  }

  /**
   * Fan input out to every active member EXCEPT the originator (which already
   * wrote its own input). Returns the ids that were written, or an empty array
   * when broadcast is off or the group has no other active members.
   *
   * This is fire-and-forget from the renderer's perspective: the backend
   * writeBroadcast resolves the ids actually written; we optimistically return
   * the intended targets for immediate UI feedback.
   */
  fanOut(originTerminalId: string, data: string): string[] {
    if (!this.enabled) return [];
    const targets = this.activeMemberIds.filter((id) => id !== originTerminalId);
    if (targets.length === 0) return [];
    // Only broadcast if the originator is itself a member — typing into a
    // non-member terminal must never leak into the group.
    if (!this.memberIds.has(originTerminalId)) return [];
    window.gyshell.terminal.writeBroadcast(targets, data).catch(() => {
      // Best-effort: backend skips dead ids; nothing to surface on the input path.
    });
    return targets;
  }
}

export const broadcastStore = new BroadcastStore();
