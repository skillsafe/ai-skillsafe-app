import { useEffect, useRef } from "react";

interface Props {
  // "col" = vertical bar dragged horizontally; "row" = horizontal bar dragged vertically.
  axis: "col" | "row";
  // Current value (px for col, percent of window for row).
  value: number;
  min: number;
  max: number;
  // Inline position style — caller passes `{ left: \`${px}px\` }` for col, etc.
  style?: React.CSSProperties;
  // Fired live as the user drags.
  onChange: (next: number) => void;
  // Optional: fires once on pointerup (use to persist final value).
  onCommit?: (next: number) => void;
  ariaLabel?: string;
}

// Thin bar overlaid on a column/row gridline. Capture-on-pointerdown so the
// drag keeps tracking even if the cursor leaves the handle's hit area.
export function ResizeHandle({
  axis,
  value,
  min,
  max,
  style,
  onChange,
  onCommit,
  ariaLabel,
}: Props) {
  // Latest value seen during this drag — committed once on pointerup so the
  // store only persists the final size.
  const latestRef = useRef(value);
  useEffect(() => { latestRef.current = value; }, [value]);

  function clamp(n: number): number {
    return Math.max(min, Math.min(max, n));
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const startClient = axis === "col" ? e.clientX : e.clientY;
    const startVal = value;

    function onMove(ev: PointerEvent) {
      if (axis === "col") {
        const next = clamp(startVal + (ev.clientX - startClient));
        latestRef.current = next;
        onChange(next);
      } else {
        // Convert pixel delta to percent-of-viewport so the persisted value is
        // resolution-independent.
        const h = window.innerHeight || 1;
        const deltaPct = ((ev.clientY - startClient) / h) * 100;
        const next = clamp(startVal + deltaPct);
        latestRef.current = next;
        onChange(next);
      }
    }
    function onUp() {
      target.releasePointerCapture(e.pointerId);
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onUp);
      if (onCommit) onCommit(latestRef.current);
    }
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);
  }

  return (
    <div
      className={`resize-handle ${axis}`}
      role="separator"
      aria-orientation={axis === "col" ? "vertical" : "horizontal"}
      aria-label={ariaLabel ?? (axis === "col" ? "Resize column" : "Resize row")}
      style={style}
      onPointerDown={onPointerDown}
    />
  );
}
