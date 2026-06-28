import assert from "node:assert/strict";
import {
  SleepBlockerService,
  type PowerSaveBlockerAdapter,
  type PowerSaveBlockerType,
} from "./SleepBlockerService";

class FakePowerSaveBlocker implements PowerSaveBlockerAdapter {
  starts: PowerSaveBlockerType[] = [];
  stops: number[] = [];
  private nextId = 1;
  private activeIds = new Set<number>();

  start(type: PowerSaveBlockerType): number {
    const id = this.nextId++;
    this.starts.push(type);
    this.activeIds.add(id);
    return id;
  }

  stop(id: number): boolean {
    this.stops.push(id);
    return this.activeIds.delete(id);
  }

  isStarted(id: number): boolean {
    return this.activeIds.has(id);
  }
}

function createService() {
  const blocker = new FakePowerSaveBlocker();
  const warnings: unknown[][] = [];
  const service = new SleepBlockerService(blocker, "prevent-app-suspension", {
    warn: (...args: unknown[]) => warnings.push(args),
  });
  return { blocker, service, warnings };
}

function runTests(): void {
  {
    const { blocker, service } = createService();
    service.setReasonActive("agent-running", true);
    service.setReasonActive("agent-running", true);

    assert.deepEqual(blocker.starts, ["prevent-app-suspension"]);
    assert.equal(service.isBlocking(), true);

    service.setReasonActive("agent-running", false);

    assert.deepEqual(blocker.stops, [1]);
    assert.equal(service.isBlocking(), false);
  }

  {
    const { blocker, service } = createService();
    service.setReasonActive("agent-running", true);
    service.setReasonActive("ssh-terminal", true);
    service.setReasonActive("agent-running", false);

    assert.deepEqual(blocker.starts, ["prevent-app-suspension"]);
    assert.deepEqual(blocker.stops, []);
    assert.equal(service.isBlocking(), true);

    service.setReasonActive("ssh-terminal", false);

    assert.deepEqual(blocker.stops, [1]);
    assert.equal(service.isBlocking(), false);
  }

  {
    const { blocker, service } = createService();
    service.setReasonActive("agent-running", true);
    service.setEnabled(false);

    assert.deepEqual(blocker.starts, ["prevent-app-suspension"]);
    assert.deepEqual(blocker.stops, [1]);
    assert.equal(service.isBlocking(), false);

    service.setEnabled(true);

    assert.deepEqual(blocker.starts, [
      "prevent-app-suspension",
      "prevent-app-suspension",
    ]);
    assert.equal(service.isBlocking(), true);
  }

  {
    const { blocker, service } = createService();
    service.setReasonActive("agent-running", true);
    service.dispose();

    assert.deepEqual(blocker.stops, [1]);
    assert.equal(service.isBlocking(), false);
  }
}

runTests();
