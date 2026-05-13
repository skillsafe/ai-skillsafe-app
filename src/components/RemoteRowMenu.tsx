import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export interface RemoteRowMenuItem {
  label: string;
  hint?: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}

interface Props {
  items: RemoteRowMenuItem[];
  ariaLabel?: string;
}

// Simple kebab popover: a "⋯" button toggles a list of action items. Closes on
// outside click or Escape. The popover is positioned above the menu trigger
// (`bottom: 100%`) so it stays inside the artifact card without clipping the
// scroll container.
export function RemoteRowMenu({ items, ariaLabel }: Props) {
  const { t } = useTranslation();
  const effectiveAriaLabel = ariaLabel ?? t("remoteRowMenu.moreActions");
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="row-menu-wrap" ref={containerRef}>
      <button
        className="row-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={effectiveAriaLabel}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        ⋯
      </button>
      {open && (
        <div className="row-menu" role="menu">
          {items.map((item, i) => (
            <button
              key={i}
              role="menuitem"
              className={`row-menu-item ${item.danger ? "danger" : ""}`}
              disabled={item.disabled}
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                item.onClick();
              }}
            >
              <span className="row-menu-item-label">{item.label}</span>
              {item.hint && <span className="row-menu-item-hint">{item.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
