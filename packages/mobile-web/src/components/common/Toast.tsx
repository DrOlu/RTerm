import React from "react";
import { CheckCircle2, X } from "lucide-react";

export interface ToastEntry {
  id: number;
  title: string;
  actionLabel?: string;
  onAction?: () => void;
}

interface ToastViewportProps {
  toasts: ToastEntry[];
  onDismiss: (id: number) => void;
}

/**
 * Lightweight ephemeral toast viewport for task-completion notifications.
 *
 * Design rationale: CC Remote Control and Codex Mobile use OS push notifications, but
 * GyShell mobile-web is a browser PWA without a reliable push channel. A page-level
 * toast (plus document.title flash) is a pragmatic substitute that covers the typical
 * "user has the app open in another browser tab" use case. When push is needed later,
 * the Web Push API + VAPID can be layered on without changing this surface.
 */
export const ToastViewport: React.FC<ToastViewportProps> = ({
  toasts,
  onDismiss,
}) => {
  return (
    <div className="toast-viewport" role="region" aria-label="notifications">
      {toasts.map((toast) => (
        <div key={toast.id} className="toast-card" role="alert">
          <div className="toast-icon">
            <CheckCircle2 size={16} />
          </div>
          <div className="toast-body">
            <span className="toast-title">{toast.title}</span>
            {toast.actionLabel && toast.onAction ? (
              <button
                type="button"
                className="toast-action"
                onClick={() => {
                  toast.onAction?.();
                  onDismiss(toast.id);
                }}
              >
                {toast.actionLabel}
              </button>
            ) : null}
          </div>
          <button
            type="button"
            className="toast-dismiss"
            onClick={() => onDismiss(toast.id)}
            aria-label="dismiss"
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
};
