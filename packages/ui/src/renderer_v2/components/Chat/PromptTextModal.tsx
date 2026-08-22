import React from "react";
import { createPortal } from "react-dom";
import { XCircle } from "lucide-react";
import "./promptText.scss";

/**
 * promptText — an in-app replacement for window.prompt().
 *
 * v3.2.10: window.prompt() THROWS ("prompt() is not supported") in Electron 42
 * renderers, which silently broke the tab/session rename feature (the throw
 * happened inside the context-menu action handler, so nothing appeared to
 * happen). This component renders the same interaction as a proper modal.
 *
 * Usage:
 *   const [rename, setRename] = useState<{ title: string; onDone: (v: string | null) => void } | null>(null);
 *   ...
 *   setRename({ title: current, onDone: (v) => { if (v) doRename(v); } });
 *   ...
 *   <PromptTextModal state={rename} onClose={() => setRename(null)} />
 */

export interface PromptTextState {
  title: string;
  label?: string;
  onDone: (value: string | null) => void;
}

export const PromptTextModal: React.FC<{
  state: PromptTextState | null;
  onClose: () => void;
}> = ({ state, onClose }) => {
  const [value, setValue] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  // Reset + focus whenever a new prompt opens.
  React.useEffect(() => {
    if (!state) return;
    setValue(state.title);
    // Focus after the portal mounts.
    const timer = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [state]);

  if (!state) return null;

  const submit = () => {
    const trimmed = value.trim();
    state.onDone(trimmed ? trimmed : null);
    onClose();
  };
  const cancel = () => {
    state.onDone(null);
    onClose();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  };

  return createPortal(
    <div
      className="gyshell-modal-overlay"
      onClick={cancel}
      role="dialog"
      aria-modal="true"
      aria-label={state.label || "Rename"}
    >
      <div className="gyshell-modal prompt-text-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{state.label || "Rename"}</h3>
          <button className="modal-close-btn" onClick={cancel} aria-label="Close">
            <XCircle size={20} />
          </button>
        </div>
        <div className="modal-body">
          <input
            ref={inputRef}
            className="prompt-text-input"
            type="text"
            value={value}
            placeholder={state.title}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            spellCheck={false}
            autoComplete="off"
          />
        </div>
        <div className="modal-footer">
          <button className="prompt-text-btn" onClick={cancel}>
            Cancel
          </button>
          <button
            className="prompt-text-btn prompt-text-btn-primary"
            onClick={submit}
            disabled={!value.trim()}
          >
            Save
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};
