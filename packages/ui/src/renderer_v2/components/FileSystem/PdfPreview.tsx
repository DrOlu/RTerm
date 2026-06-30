import React from "react";
import { Minus, Plus } from "lucide-react";
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  RenderTask,
} from "pdfjs-dist";
import pdfWorkerSrc from "pdfjs-dist/build/pdf.worker.js?url";
import {
  clampPreviewValue,
  resolveAnchoredPreviewScrollOffset,
  resolvePreviewWheelZoomMultiplier,
  shouldHandlePreviewWheelZoom,
} from "./previewInteractions";

type PdfJsRuntime = Pick<
  typeof import("pdfjs-dist"),
  "getDocument" | "GlobalWorkerOptions"
>;
type PdfJsModule = typeof import("pdfjs-dist") & {
  default?: PdfJsRuntime;
};

let pdfJsRuntimePromise: Promise<PdfJsRuntime> | null = null;

const loadPdfJsRuntime = async (): Promise<PdfJsRuntime> => {
  if (!pdfJsRuntimePromise) {
    pdfJsRuntimePromise = import("pdfjs-dist").then((pdfModule) => {
      const runtime =
        "getDocument" in pdfModule
          ? (pdfModule as PdfJsRuntime)
          : (pdfModule as PdfJsModule).default;
      if (!runtime) {
        throw new Error("PDF runtime failed to load.");
      }
      runtime.GlobalWorkerOptions.workerSrc = pdfWorkerSrc;
      return runtime;
    });
  }
  return pdfJsRuntimePromise;
};

interface PdfPreviewLabels {
  loadingDocument: string;
  renderingPage: string;
  previousPage: string;
  nextPage: string;
  zoomIn: string;
  zoomOut: string;
  pageLabel: (current: number, total: number) => string;
  renderError: string;
}

interface PdfPreviewProps {
  contentBase64: string;
  filePath: string;
  labels: PdfPreviewLabels;
}

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.2;
const NATIVE_PDF_VIEWER_OPEN_PARAMETERS = "pagemode=none&navpanes=0";

const clamp = (value: number, min: number, max: number): number =>
  clampPreviewValue(value, min, max);

interface PendingPdfZoomAnchor {
  localX: number;
  localY: number;
  oldZoom: number;
  newZoom: number;
  scrollLeft: number;
  scrollTop: number;
}

interface PdfPanState {
  pointerId: number;
  startX: number;
  startY: number;
  scrollLeft: number;
  scrollTop: number;
}

const base64ToUint8Array = (base64: string): Uint8Array => {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const buildNativePdfViewerUrl = (objectUrl: string): string =>
  `${objectUrl}#${NATIVE_PDF_VIEWER_OPEN_PARAMETERS}`;

export const PdfPreview: React.FC<PdfPreviewProps> = ({
  contentBase64,
  filePath,
  labels,
}) => {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const pendingPdfZoomAnchorRef = React.useRef<PendingPdfZoomAnchor | null>(
    null,
  );
  const pdfPanStateRef = React.useRef<PdfPanState | null>(null);
  const [pdfDocument, setPdfDocument] = React.useState<PDFDocumentProxy | null>(
    null,
  );
  const [pageNumber, setPageNumber] = React.useState(1);
  const [pageCount, setPageCount] = React.useState(0);
  const [zoom, setZoom] = React.useState(1);
  const zoomRef = React.useRef(zoom);
  const [containerWidth, setContainerWidth] = React.useState(0);
  const [nativePdfUrl, setNativePdfUrl] = React.useState("");
  const [usePdfJsFallback, setUsePdfJsFallback] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [rendering, setRendering] = React.useState(false);
  const [isPdfPanning, setPdfPanning] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

  React.useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  React.useEffect(() => {
    setUsePdfJsFallback(false);
    setNativePdfUrl("");
    setPdfDocument(null);
    setPageNumber(1);
    setPageCount(0);
    setZoom(1);
    setLoading(true);
    setRendering(false);
    setErrorMessage(null);
    pendingPdfZoomAnchorRef.current = null;
    pdfPanStateRef.current = null;

    let objectUrl = "";
    try {
      const pdfBytes = base64ToUint8Array(contentBase64);
      const pdfBuffer = new ArrayBuffer(pdfBytes.byteLength);
      new Uint8Array(pdfBuffer).set(pdfBytes);
      const blob = new Blob([pdfBuffer], {
        type: "application/pdf",
      });
      objectUrl = URL.createObjectURL(blob);
      setNativePdfUrl(buildNativePdfViewerUrl(objectUrl));
      setLoading(false);
    } catch (error) {
      setUsePdfJsFallback(true);
      setLoading(false);
      setErrorMessage(
        error instanceof Error && error.message.trim()
          ? error.message
          : labels.renderError,
      );
    }

    return () => {
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [contentBase64, labels.renderError]);

  React.useEffect(() => {
    if (!usePdfJsFallback) {
      return;
    }

    const container = containerRef.current;
    if (!container) return;

    const updateWidth = (): void => {
      setContainerWidth(container.clientWidth);
    };
    updateWidth();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateWidth);
      return () => window.removeEventListener("resize", updateWidth);
    }

    const observer = new ResizeObserver(updateWidth);
    observer.observe(container);
    return () => observer.disconnect();
  }, [usePdfJsFallback]);

  React.useEffect(() => {
    if (!usePdfJsFallback) {
      return;
    }

    let cancelled = false;
    let loadingTask: PDFDocumentLoadingTask | null = null;

    setPdfDocument(null);
    setPageNumber(1);
    setPageCount(0);
    setLoading(true);
    setRendering(false);
    setErrorMessage(null);

    loadPdfJsRuntime()
      .then((runtime) => {
        if (cancelled) return null;
        loadingTask = runtime.getDocument({
          data: base64ToUint8Array(contentBase64),
        });
        return loadingTask.promise;
      })
      .then((document) => {
        if (!document) return;
        if (cancelled) {
          void document.destroy();
          return;
        }
        setPdfDocument(document);
        setPageCount(document.numPages);
        setLoading(false);
      })
      .catch((error) => {
        if (cancelled) return;
        setLoading(false);
        setErrorMessage(
          error instanceof Error && error.message.trim()
            ? error.message
            : labels.renderError,
        );
      });

    return () => {
      cancelled = true;
      if (loadingTask) {
        void loadingTask.destroy();
      }
    };
  }, [contentBase64, labels.renderError, usePdfJsFallback]);

  React.useEffect(() => {
    return () => {
      if (pdfDocument) {
        void pdfDocument.destroy();
      }
    };
  }, [pdfDocument]);

  const queuePdfZoomAnchor = React.useCallback(
    (nextZoom: number, clientX?: number, clientY?: number): void => {
      const container = containerRef.current;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      const localX =
        typeof clientX === "number"
          ? clientX - rect.left
          : container.clientWidth / 2;
      const localY =
        typeof clientY === "number"
          ? clientY - rect.top
          : container.clientHeight / 2;

      pendingPdfZoomAnchorRef.current = {
        localX,
        localY,
        oldZoom: zoomRef.current,
        newZoom: nextZoom,
        scrollLeft: container.scrollLeft,
        scrollTop: container.scrollTop,
      };
    },
    [],
  );

  const applyPendingPdfZoomAnchor = React.useCallback((): void => {
    const pending = pendingPdfZoomAnchorRef.current;
    const container = containerRef.current;
    if (!pending || !container) return;
    pendingPdfZoomAnchorRef.current = null;

    container.scrollLeft = resolveAnchoredPreviewScrollOffset({
      scrollOffset: pending.scrollLeft,
      pointerOffset: pending.localX,
      oldScale: pending.oldZoom,
      newScale: pending.newZoom,
      maxScrollOffset: container.scrollWidth - container.clientWidth,
    });
    container.scrollTop = resolveAnchoredPreviewScrollOffset({
      scrollOffset: pending.scrollTop,
      pointerOffset: pending.localY,
      oldScale: pending.oldZoom,
      newScale: pending.newZoom,
      maxScrollOffset: container.scrollHeight - container.clientHeight,
    });
  }, []);

  const setPdfZoom = React.useCallback(
    (nextZoomInput: number, clientX?: number, clientY?: number): void => {
      const nextZoom = clamp(nextZoomInput, MIN_ZOOM, MAX_ZOOM);
      if (Math.abs(nextZoom - zoomRef.current) < 0.0001) {
        return;
      }
      queuePdfZoomAnchor(nextZoom, clientX, clientY);
      setZoom(nextZoom);
    },
    [queuePdfZoomAnchor],
  );

  const handlePdfWheel = React.useCallback(
    (event: React.WheelEvent<HTMLDivElement>): void => {
      if (!shouldHandlePreviewWheelZoom(event)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();

      const multiplier = resolvePreviewWheelZoomMultiplier(
        event.deltaY,
        event.deltaMode,
      );
      setPdfZoom(zoomRef.current * multiplier, event.clientX, event.clientY);
    },
    [setPdfZoom],
  );

  const finishPdfPan = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      const container = containerRef.current;
      const panState = pdfPanStateRef.current;
      if (!container || !panState || panState.pointerId !== event.pointerId) {
        return;
      }
      pdfPanStateRef.current = null;
      if (container.hasPointerCapture(event.pointerId)) {
        container.releasePointerCapture(event.pointerId);
      }
      setPdfPanning(false);
    },
    [],
  );

  const handlePdfPointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      const container = containerRef.current;
      if (
        !container ||
        event.button !== 0 ||
        (container.scrollWidth <= container.clientWidth + 1 &&
          container.scrollHeight <= container.clientHeight + 1)
      ) {
        return;
      }

      pdfPanStateRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        scrollLeft: container.scrollLeft,
        scrollTop: container.scrollTop,
      };
      container.setPointerCapture(event.pointerId);
      setPdfPanning(true);
      event.preventDefault();
    },
    [],
  );

  const handlePdfPointerMove = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      const container = containerRef.current;
      const panState = pdfPanStateRef.current;
      if (!container || !panState || panState.pointerId !== event.pointerId) {
        return;
      }
      container.scrollLeft =
        panState.scrollLeft - (event.clientX - panState.startX);
      container.scrollTop =
        panState.scrollTop - (event.clientY - panState.startY);
      event.preventDefault();
    },
    [],
  );

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!usePdfJsFallback || !pdfDocument || !canvas || containerWidth <= 0) {
      return;
    }

    let cancelled = false;
    let renderTask: RenderTask | null = null;

    setRendering(true);
    setErrorMessage(null);

    pdfDocument
      .getPage(pageNumber)
      .then((page) => {
        if (cancelled) return undefined;

        const baseViewport = page.getViewport({ scale: 1 });
        const availableWidth = Math.max(160, containerWidth - 32);
        const fitScale = availableWidth / baseViewport.width;
        const scale = clamp(fitScale * zoom, 0.25, 4);
        const viewport = page.getViewport({ scale });
        const outputScale = window.devicePixelRatio || 1;
        const context = canvas.getContext("2d");
        if (!context) {
          throw new Error("Canvas rendering is unavailable.");
        }

        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;

        renderTask = page.render({
          canvasContext: context,
          viewport,
          transform:
            outputScale !== 1
              ? [outputScale, 0, 0, outputScale, 0, 0]
              : undefined,
        });
        return renderTask.promise;
      })
      .then(() => {
        if (!cancelled) {
          setRendering(false);
          window.requestAnimationFrame(() => {
            applyPendingPdfZoomAnchor();
          });
        }
      })
      .catch((error) => {
        if (
          cancelled ||
          (error instanceof Error &&
            error.name === "RenderingCancelledException")
        ) {
          return;
        }
        setRendering(false);
        setErrorMessage(
          error instanceof Error && error.message.trim()
            ? error.message
            : labels.renderError,
        );
      });

    return () => {
      cancelled = true;
      if (renderTask) {
        renderTask.cancel();
      }
    };
  }, [
    applyPendingPdfZoomAnchor,
    containerWidth,
    labels.renderError,
    pageNumber,
    pdfDocument,
    usePdfJsFallback,
    zoom,
  ]);

  const canGoPrevious = pageNumber > 1;
  const canGoNext = pageCount > 0 && pageNumber < pageCount;

  if (!usePdfJsFallback) {
    return (
      <div
        className="file-editor-pdf-preview is-native"
        data-testid="pdf-preview"
      >
        {nativePdfUrl ? (
          <iframe
            className="file-editor-pdf-native-frame"
            src={nativePdfUrl}
            title={filePath}
            onError={() => {
              setUsePdfJsFallback(true);
            }}
          />
        ) : (
          <div className="file-editor-empty-state">
            {labels.loadingDocument}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="file-editor-pdf-preview" data-testid="pdf-preview">
      <div className="file-editor-pdf-toolbar">
        <button
          className="file-editor-preview-btn"
          type="button"
          onClick={() => setPageNumber((current) => Math.max(1, current - 1))}
          disabled={!canGoPrevious || loading}
        >
          {labels.previousPage}
        </button>
        <span className="file-editor-pdf-page-label">
          {pageCount > 0 ? labels.pageLabel(pageNumber, pageCount) : filePath}
        </span>
        <button
          className="file-editor-preview-btn"
          type="button"
          onClick={() =>
            setPageNumber((current) =>
              pageCount > 0 ? Math.min(pageCount, current + 1) : current,
            )
          }
          disabled={!canGoNext || loading}
        >
          {labels.nextPage}
        </button>
        <span className="file-editor-pdf-toolbar-spacer" />
        <button
          className="file-editor-preview-btn file-editor-preview-btn-icon"
          type="button"
          title={labels.zoomOut}
          aria-label={labels.zoomOut}
          onClick={() => setPdfZoom(zoomRef.current - ZOOM_STEP)}
          disabled={loading || zoom <= MIN_ZOOM}
        >
          <Minus size={14} strokeWidth={2.2} />
        </button>
        <span className="file-editor-pdf-zoom-label">
          {Math.round(zoom * 100)}%
        </span>
        <button
          className="file-editor-preview-btn file-editor-preview-btn-icon"
          type="button"
          title={labels.zoomIn}
          aria-label={labels.zoomIn}
          onClick={() => setPdfZoom(zoomRef.current + ZOOM_STEP)}
          disabled={loading || zoom >= MAX_ZOOM}
        >
          <Plus size={14} strokeWidth={2.2} />
        </button>
      </div>
      <div
        ref={containerRef}
        className={`file-editor-pdf-canvas-wrap${isPdfPanning ? " is-panning" : ""}`}
        onWheel={handlePdfWheel}
        onPointerDown={handlePdfPointerDown}
        onPointerMove={handlePdfPointerMove}
        onPointerUp={finishPdfPan}
        onPointerCancel={finishPdfPan}
        onPointerLeave={finishPdfPan}
      >
        {loading ? (
          <div className="file-editor-empty-state">
            {labels.loadingDocument}
          </div>
        ) : errorMessage ? (
          <div className="file-editor-error">{errorMessage}</div>
        ) : (
          <>
            {rendering ? (
              <div className="file-editor-pdf-rendering">
                {labels.renderingPage}
              </div>
            ) : null}
            <div className="file-editor-pdf-canvas-stage">
              <canvas
                ref={canvasRef}
                className="file-editor-pdf-canvas"
                aria-label={filePath}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
};
