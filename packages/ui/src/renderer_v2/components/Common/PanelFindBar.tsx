import React from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import "./panelFind.scss";

interface PanelFindBarProps {
  inputRef?: React.Ref<HTMLInputElement>;
  value: string;
  placeholder: string;
  resultLabel: string;
  onChange: (value: string) => void;
  onPrevious: () => void;
  onNext: () => void;
  onClose: () => void;
  disableNavigation?: boolean;
}

export const PanelFindBar: React.FC<PanelFindBarProps> = ({
  inputRef,
  value,
  placeholder,
  resultLabel,
  onChange,
  onPrevious,
  onNext,
  onClose,
  disableNavigation = false,
}) => (
  <div className="panel-find-bar">
    <input
      ref={inputRef}
      className="panel-find-input"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          onPrevious();
          return;
        }
        if (event.key === "ArrowDown") {
          event.preventDefault();
          onNext();
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          if (event.shiftKey) {
            onPrevious();
            return;
          }
          onNext();
        }
      }}
      placeholder={placeholder}
      spellCheck={false}
      data-panel-find-input="true"
    />
    {resultLabel ? (
      <span className="panel-find-count">{resultLabel}</span>
    ) : null}
    <div className="panel-find-actions">
      <button
        type="button"
        className="panel-find-btn"
        title="Previous match"
        onClick={onPrevious}
        disabled={disableNavigation}
      >
        <ChevronUp size={14} strokeWidth={2} />
      </button>
      <button
        type="button"
        className="panel-find-btn"
        title="Next match"
        onClick={onNext}
        disabled={disableNavigation}
      >
        <ChevronDown size={14} strokeWidth={2} />
      </button>
      <button
        type="button"
        className="panel-find-btn"
        title="Close search"
        onClick={onClose}
      >
        <X size={14} strokeWidth={2} />
      </button>
    </div>
  </div>
);
