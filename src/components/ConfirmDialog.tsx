import { useTranslation } from "react-i18next";

interface Props {
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: Props) {
  const { t } = useTranslation();
  const confirmText = confirmLabel ?? t("confirm.confirmLabel");
  const cancelText = cancelLabel ?? t("common.cancel");
  return (
    <div className="dialog-backdrop" onClick={busy ? undefined : onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <div className="confirm-message">{message}</div>
        <div className="dialog-row">
          <button onClick={onCancel} disabled={busy}>{cancelText}</button>
          <button
            className={danger ? "danger" : "primary"}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? t("common.working") : confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
