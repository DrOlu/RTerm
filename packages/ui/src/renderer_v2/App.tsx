import React from "react";
import { observer } from "mobx-react-lite";
import { AppStore } from "./stores/AppStore";
import { TopBar } from "./components/TopBar/TopBar";
import { SettingsView } from "./components/Settings/SettingsView";
import { ConnectionsView } from "./components/Connections/ConnectionsView";
import { ConfirmDialog } from "./components/Common/ConfirmDialog";
import { ToastStack } from "./components/Common/ToastStack";
import { CommandPalette } from "./components/Common/CommandPalette";
import { LayoutWorkspace } from "./components/Layout/LayoutWorkspace";
import { shouldShowHistoryMigrationOverlay } from "./lib/historyMigrationOverlay";
import { toastStore } from "./components/Common/ToastStore";
import "./styles/app.scss";

const store = new AppStore();

export const App: React.FC = observer(() => {
  React.useEffect(() => {
    store.bootstrap();
  }, []);

  // Global keyboard shortcut: Cmd/Ctrl+K opens the command palette.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        (window as any).__rtermTogglePalette?.();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // PuTTY import hook: the command palette (and a future menu item) dispatches
  // a custom event; here we trigger a hidden file picker and import the file.
  React.useEffect(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".reg,.txt";
    input.style.display = "none";
    const handler = async () => {
      input.value = "";
      input.click();
    };
    const onChange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const text = await file.text();
      try {
        const n = await store.importPuttySessions(text);
        toastStore.push({ title: n > 0 ? "PuTTY import" : "PuTTY import", message: n > 0 ? `Imported ${n} SSH connection(s).` : "No new SSH sessions found.", kind: n > 0 ? "success" : "default" });
      } catch (e: any) {
        toastStore.push({ title: "Import failed", message: e?.message ?? "Could not parse file.", kind: "danger" });
      }
    };
    document.addEventListener("rterm:putty-import", handler);
    input.addEventListener("change", onChange);
    return () => {
      document.removeEventListener("rterm:putty-import", handler);
      input.removeEventListener("change", onChange);
    };
  }, []);

  React.useEffect(() => {
    let flushed = false;
    const flushLayoutBeforeUnload = () => {
      if (flushed || !store.isBootstrapped || !store.layout.isReady) {
        return;
      }
      flushed = true;
      store.layout.flushPendingSaveSync();
    };

    window.addEventListener("beforeunload", flushLayoutBeforeUnload);
    window.addEventListener("pagehide", flushLayoutBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", flushLayoutBeforeUnload);
      window.removeEventListener("pagehide", flushLayoutBeforeUnload);
    };
  }, []);

  React.useEffect(() => {
    const canHandleNativeFileDrop = (target: EventTarget | null): boolean => {
      const element = target as HTMLElement | null;
      if (!element || typeof element.closest !== "function") {
        return false;
      }
      return Boolean(
        element.closest(".xterm-host, .filesystem-list, .rich-input-editor"),
      );
    };

    const isNativeFileDrag = (event: DragEvent): boolean => {
      const types = Array.from(event.dataTransfer?.types || []);
      return types.includes("Files");
    };

    const handleDragOver = (event: DragEvent) => {
      if (!isNativeFileDrag(event)) return;
      if (canHandleNativeFileDrop(event.target)) return;
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "none";
      }
    };

    const handleDrop = (event: DragEvent) => {
      if (!isNativeFileDrag(event)) return;
      if (canHandleNativeFileDrop(event.target)) return;
      event.preventDefault();
    };

    window.addEventListener("dragover", handleDragOver, true);
    window.addEventListener("drop", handleDrop, true);
    return () => {
      window.removeEventListener("dragover", handleDragOver, true);
      window.removeEventListener("drop", handleDrop, true);
    };
  }, []);

  const platform = (window as any)?.gyshell?.system?.platform;
  const t = store.i18n.t;
  const versionInfo = store.versionInfo;
  const historyMigrationState = store.historyMigrationState;
  const showHistoryMigrationOverlay =
    shouldShowHistoryMigrationOverlay(historyMigrationState);
  const migrationPercent = Math.max(
    0,
    Math.min(100, historyMigrationState?.percent ?? 0),
  );
  const hasVersionDifference =
    !!versionInfo &&
    versionInfo.status !== "error" &&
    typeof versionInfo.latestVersion === "string" &&
    versionInfo.latestVersion.length > 0 &&
    versionInfo.latestVersion !== versionInfo.currentVersion;
  const platformClass =
    platform === "win32"
      ? "platform-windows"
      : platform === "darwin"
        ? "platform-darwin"
        : platform === "linux"
          ? "platform-linux"
          : navigator.userAgent.toLowerCase().includes("windows")
            ? "platform-windows"
            : "platform-darwin";

  return (
    <div className={`gyshell ${platformClass}`}>
      <ConfirmDialog
        open={store.showVersionUpdateDialog && hasVersionDifference}
        title={t.settings.versionUpdateTitle}
        message={`${
          versionInfo?.status === "update-available"
            ? t.settings.versionUpdateMessage(
                versionInfo?.currentVersion || "-",
                versionInfo?.latestVersion || "-",
              )
            : t.settings.versionDifferentMessage(
                versionInfo?.currentVersion || "-",
                versionInfo?.latestVersion || "-",
              )
        }\n\n${t.settings.versionCheckNote}`}
        confirmText={t.settings.goToDownload}
        cancelText={t.common.close}
        onCancel={() => store.closeVersionUpdateDialog()}
        onConfirm={() => {
          void store.openVersionDownload();
          store.closeVersionUpdateDialog();
        }}
      />

      <TopBar store={store} />

      <div className="gyshell-body">
        <div className="gyshell-main">
          <LayoutWorkspace store={store} />
        </div>

        {/* Settings is an overlay so we don't unmount terminals (xterm state stays alive) */}
        <div
          className={`gyshell-overlay settings-overlay${store.view === "settings" ? " is-open" : ""}`}
        >
          <SettingsView store={store} />
        </div>

        <div
          className={`gyshell-overlay connections-overlay${store.view === "connections" ? " is-open" : ""}`}
        >
          <ConnectionsView store={store} />
        </div>

        {showHistoryMigrationOverlay ? (
          <div className="gyshell-startup-overlay">
            <div className="gyshell-startup-modal">
              <p className="gyshell-startup-kicker">System Notice</p>
              <h2>
                {historyMigrationState?.title || "Preparing history storage"}
              </h2>
              <p>
                {historyMigrationState?.message ||
                  "Checking stored conversations."}
              </p>
              <div
                className="gyshell-startup-progress-track"
                aria-hidden="true"
              >
                <div
                  className="gyshell-startup-progress-fill"
                  style={{ width: `${migrationPercent}%` }}
                />
              </div>
              <div className="gyshell-startup-progress-meta">
                <span>{migrationPercent}%</span>
                <span>
                  {historyMigrationState?.completedUnits || 0}/
                  {historyMigrationState?.totalUnits || 0}
                </span>
              </div>
              {historyMigrationState?.error ? (
                <pre className="gyshell-startup-error">
                  {historyMigrationState.error}
                </pre>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
      {/* Visual enhancements (1.7.4): toast notifications + command palette */}
      <ToastStack />
      <CommandPalette store={store} />
    </div>
  );
});
