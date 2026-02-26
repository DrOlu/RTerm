import React from "react";
import { ImagePlus, Lock, SendHorizontal, Square, X } from "lucide-react";
import { useMobileI18n } from "../../i18n/provider";
import { extractClipboardImageFiles } from "../../lib/input-images";
import {
  consumeMentionBackspace,
  type MentionOption,
} from "../../lib/mentions";
import type { GatewayProfileSummary } from "../../types";
import { MentionSuggestions } from "./MentionSuggestions";

interface ComposerBarProps {
  value: string;
  cursor: number;
  images: Array<{
    id: string;
    attachmentId?: string;
    fileName?: string;
    previewUrl: string;
  }>;
  onChange: (value: string, cursor: number) => void;
  onCursorChange: (cursor: number) => void;
  onAttachImages: (files: File[]) => void;
  onRemoveImage: (imageId: string) => void;
  onClearImages: () => void;
  onSend: () => void;
  onStop: () => void;
  canSend: boolean;
  isRunning: boolean;
  profiles: GatewayProfileSummary[];
  activeProfileId: string;
  lockedProfileId: string | null;
  tokenUsagePercent: number | null;
  onUpdateProfile: (profileId: string) => void;
  mentionOptions: MentionOption[];
  onPickMention: (option: MentionOption) => void;
}

export const ComposerBar: React.FC<ComposerBarProps> = ({
  value,
  cursor,
  images,
  onChange,
  onCursorChange,
  onAttachImages,
  onRemoveImage,
  onClearImages,
  onSend,
  onStop,
  canSend,
  isRunning,
  profiles,
  activeProfileId,
  lockedProfileId,
  tokenUsagePercent,
  onUpdateProfile,
  mentionOptions,
  onPickMention,
}) => {
  const { t } = useMobileI18n();
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const imageInputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    const input = textareaRef.current;
    if (!input) return;
    input.style.height = "0px";
    const next = Math.min(Math.max(input.scrollHeight, 36), 160);
    input.style.height = `${next}px`;
  }, [value]);

  React.useEffect(() => {
    const input = textareaRef.current;
    if (!input) return;
    if (document.activeElement !== input) return;
    if (input.selectionStart !== input.selectionEnd) return;
    if (input.selectionStart === cursor && input.selectionEnd === cursor)
      return;
    input.setSelectionRange(cursor, cursor);
  }, [cursor, value]);

  const handleSend = React.useCallback(() => {
    onSend();
  }, [onSend]);

  const profileLocked = Boolean(isRunning && lockedProfileId);
  const profileValue =
    lockedProfileId || activeProfileId || profiles[0]?.id || "";

  return (
    <footer className="composer-modern">
      <MentionSuggestions options={mentionOptions} onPick={onPickMention} />

      {images.length > 0 ? (
        <div className="composer-image-strip">
          <button
            type="button"
            className="composer-image-clear-all"
            onClick={onClearImages}
            aria-label={t.composer.clearImages}
            title={t.composer.clearImages}
          >
            <span>ALL</span>
          </button>
          {images.map((image) => (
            <div key={image.id} className="composer-image-chip">
              <button
                type="button"
                className="composer-image-remove"
                onClick={() => onRemoveImage(image.id)}
                aria-label={t.composer.removeImage}
                title={t.composer.removeImage}
              >
                <X size={10} />
              </button>
              {image.previewUrl ? (
                <img src={image.previewUrl} alt={image.fileName || image.attachmentId || "image"} />
              ) : (
                <div className="composer-image-placeholder">IMG</div>
              )}
              <span>{image.fileName || image.attachmentId || "image"}</span>
            </div>
          ))}
        </div>
      ) : null}

      <div className="composer-textarea-row">
        <textarea
          ref={textareaRef}
          value={value}
          rows={1}
          onChange={(event) =>
            onChange(event.target.value, event.target.selectionStart || 0)
          }
          onSelect={(event) => {
            const start = event.currentTarget.selectionStart || 0;
            const end = event.currentTarget.selectionEnd || 0;
            if (start !== end) return;
            onCursorChange(start);
          }}
          onBeforeInput={(event) => {
            const nativeEvent = event.nativeEvent as InputEvent;
            if (nativeEvent.inputType !== "deleteContentBackward") return;
            const target = event.currentTarget;
            const start = target.selectionStart || 0;
            const end = target.selectionEnd || 0;
            const collapsedDelete = consumeMentionBackspace(value, start, end);
            if (!collapsedDelete) return;
            event.preventDefault();
            onChange(collapsedDelete.value, collapsedDelete.cursor);
          }}
          onKeyDown={(event) => {
            if (event.key === "Backspace") {
              const target = event.currentTarget;
              const start = target.selectionStart || 0;
              const end = target.selectionEnd || 0;
              const collapsedDelete = consumeMentionBackspace(
                value,
                start,
                end,
              );
              if (collapsedDelete) {
                event.preventDefault();
                onChange(collapsedDelete.value, collapsedDelete.cursor);
                return;
              }
            }
          }}
          onPaste={(event) => {
            const imageFiles = extractClipboardImageFiles(event.clipboardData);
            if (imageFiles.length === 0) return;
            event.preventDefault();
            onAttachImages(imageFiles);
          }}
          placeholder={t.composer.placeholder}
          autoCorrect="off"
          autoCapitalize="sentences"
        />
      </div>

      <div className="composer-bottom-row">
        <div className="composer-row-left">
          <div
            className={`composer-profile-selector ${profileLocked ? "locked" : ""}`}
          >
            {profileLocked ? <Lock size={10} /> : null}
            <select
              value={profileValue}
              disabled={profileLocked || profiles.length === 0}
              onChange={(event) => onUpdateProfile(event.target.value)}
            >
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </div>
          {tokenUsagePercent !== null ? (
            <span className="composer-token-label">{tokenUsagePercent}%</span>
          ) : null}
        </div>

        <div className="composer-row-right">
          <input
            ref={imageInputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,image/*"
            multiple
            style={{ display: "none" }}
            onChange={(event) => {
              const files = Array.from(event.target.files || []);
              if (files.length > 0) {
                onAttachImages(files);
              }
              event.currentTarget.value = "";
            }}
          />
          <button
            type="button"
            className="composer-icon-button image"
            onClick={() => imageInputRef.current?.click()}
            aria-label={t.composer.attachImage}
            title={t.composer.attachImage}
          >
            <ImagePlus size={14} />
          </button>
          {isRunning ? (
            <button
              type="button"
              className="composer-icon-button stop"
              onClick={onStop}
              aria-label={t.composer.stopRun}
              title={t.composer.stopRun}
            >
              <Square size={12} />
            </button>
          ) : null}
          <button
            type="button"
            className="composer-icon-button send"
            onClick={handleSend}
            disabled={!canSend}
            aria-label={t.composer.sendMessage}
            title={t.composer.send}
          >
            <SendHorizontal size={14} />
          </button>
        </div>
      </div>
    </footer>
  );
};
