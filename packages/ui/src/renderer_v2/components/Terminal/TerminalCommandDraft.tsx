import React from "react";
import { createPortal } from "react-dom";
import { SendHorizontal, X } from "lucide-react";
import { Select, type SelectHandle } from "../../platform/Select";
import {
  createImeCompositionTracker,
  disposeImeCompositionTracker,
  markImeCompositionEnd,
  markImeCompositionStart,
  shouldLetImeHandleKeyDown,
  shouldSuppressPostCompositionEnter,
} from "../../lib/imeComposition";
import "./terminalCommandDraft.scss";

export interface TerminalCommandDraftLabels {
  title: string;
  placeholder: string;
  send: string;
  shortcutHint: string;
  pending: string;
  failed: string;
  noProfile: string;
}

export function TerminalCommandDraft(props: {
  open: boolean;
  value: string;
  position: { left: number; top: number; width?: number } | null;
  profileId: string;
  profileOptions: Array<{ id: string; name: string }>;
  labels: TerminalCommandDraftLabels;
  onChange: (value: string) => void;
  onProfileChange: (profileId: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}): React.ReactElement | null {
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const cardRef = React.useRef<HTMLDivElement | null>(null);
  const profileSelectRef = React.useRef<SelectHandle | null>(null);
  const imeCompositionRef = React.useRef(createImeCompositionTracker());

  const adjustInputHeight = React.useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const styles = window.getComputedStyle(textarea);
    const lineHeight = Number.parseFloat(styles.lineHeight) || 16;
    const paddingTop = Number.parseFloat(styles.paddingTop) || 0;
    const paddingBottom = Number.parseFloat(styles.paddingBottom) || 0;
    const maxHeight = lineHeight * 3 + paddingTop + paddingBottom;
    textarea.style.height = "0px";
    const nextHeight = Math.min(maxHeight, textarea.scrollHeight);
    textarea.style.height = `${Math.max(lineHeight + paddingTop + paddingBottom, nextHeight)}px`;
    textarea.style.overflowY =
      textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  }, []);

  React.useEffect(() => {
    if (!props.open) return;
    const timer = window.setTimeout(() => {
      textareaRef.current?.focus();
      textareaRef.current?.select();
      adjustInputHeight();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [adjustInputHeight, props.open]);

  React.useLayoutEffect(() => {
    if (!props.open) return;
    adjustInputHeight();
  }, [adjustInputHeight, props.open, props.value]);

  React.useEffect(() => {
    if (!props.open) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      const targetElement = target instanceof Element ? target : null;
      if (target && cardRef.current?.contains(target)) {
        return;
      }
      if (targetElement?.closest(".terminal-command-draft-profile-menu")) {
        return;
      }
      props.onCancel();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        props.onCancel();
      }
    };

    document.addEventListener("mousedown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [props.onCancel, props.open]);

  React.useEffect(() => {
    return () => {
      disposeImeCompositionTracker(imeCompositionRef.current);
    };
  }, []);

  if (!props.open) {
    return null;
  }

  const position = props.position || {
    left: Math.round(window.innerWidth / 2 - 210),
    top: Math.round(window.innerHeight / 2 - 76),
    width: 420,
  };
  const hasSelectableProfiles =
    props.profileOptions.length > 0 && props.profileId.trim().length > 0;
  const canSubmit = props.value.trim().length > 0 && hasSelectableProfiles;
  const selectOptions =
    props.profileOptions.length > 0
      ? props.profileOptions.map((option) => ({
          value: option.id,
          label: option.name,
        }))
      : [{ value: "", label: props.labels.noProfile }];

  return createPortal(
    props.open ? (
      <div
        ref={cardRef}
        className="terminal-command-draft-popover"
        role="dialog"
        style={{
          left: `${position.left}px`,
          top: `${position.top}px`,
          width: position.width ? `${position.width}px` : undefined,
        }}
      >
        <div className="terminal-command-draft-header">
          <div className="terminal-command-draft-title">
            <span className="terminal-command-draft-sigil">[cmd]</span>
            <span>{props.labels.title}</span>
          </div>
          <button
            className="icon-btn-sm"
            type="button"
            onClick={props.onCancel}
            title={props.labels.title}
            aria-label={props.labels.title}
          >
            <X size={16} />
          </button>
        </div>
        <div className="terminal-command-draft-body">
          <div className="terminal-command-draft-prefix">$</div>
          <textarea
            ref={textareaRef}
            className="terminal-command-draft-input"
            value={props.value}
            placeholder={props.labels.placeholder}
            rows={1}
            spellCheck={false}
            onChange={(event) => props.onChange(event.target.value)}
            onCompositionStart={() =>
              markImeCompositionStart(imeCompositionRef.current)
            }
            onCompositionEnd={() =>
              markImeCompositionEnd(imeCompositionRef.current)
            }
            onKeyDown={(event) => {
              if (shouldLetImeHandleKeyDown(imeCompositionRef.current, event)) {
                return;
              }
              if (
                shouldSuppressPostCompositionEnter(
                  imeCompositionRef.current,
                  event,
                )
              ) {
                event.preventDefault();
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                props.onCancel();
                return;
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                if (canSubmit) {
                  props.onSubmit();
                }
              }
            }}
          />
        </div>
        <div className="terminal-command-draft-footer">
          <div className="terminal-command-draft-meta">
            <div
              className={`terminal-command-draft-profile-selector${hasSelectableProfiles ? "" : " is-disabled"}`}
              onClick={() => {
                if (hasSelectableProfiles) {
                  profileSelectRef.current?.toggle();
                }
              }}
              title={
                selectOptions.find((option) => option.value === props.profileId)
                  ?.label || props.labels.noProfile
              }
            >
              <span
                className="terminal-command-draft-profile-icon"
                aria-hidden="true"
              >
                ❯_
              </span>
              <Select
                ref={profileSelectRef}
                className="terminal-command-draft-profile-dropdown"
                value={hasSelectableProfiles ? props.profileId : ""}
                options={selectOptions}
                disabled={!hasSelectableProfiles}
                onChange={(nextId) => {
                  if (nextId) {
                    props.onProfileChange(nextId);
                  }
                }}
                hideArrow
                menuClassName="terminal-command-draft-profile-menu"
                menuZIndex={21000}
              />
            </div>
            <div className="terminal-command-draft-hint">
              {props.labels.shortcutHint}
            </div>
          </div>
          <button
            className="gy-btn gy-btn-primary terminal-command-draft-submit"
            type="button"
            onClick={props.onSubmit}
            disabled={!canSubmit}
            title={props.labels.send}
            aria-label={props.labels.send}
          >
            <SendHorizontal size={14} />
          </button>
        </div>
      </div>
    ) : null,
    document.body,
  );
}
