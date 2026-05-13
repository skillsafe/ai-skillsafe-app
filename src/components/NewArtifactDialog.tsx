import { useState } from "react";
import { useTranslation } from "react-i18next";

interface Props {
  onCancel: () => void;
  onCreate: (name: string, description: string) => Promise<void>;
}

export function NewArtifactDialog({ onCancel, onCreate }: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    const slug = name.trim();
    if (!slug) return;
    setBusy(true);
    try {
      await onCreate(slug, description.trim());
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{t("newArtifact.title")}</h3>
        <div className="fm-field">
          <label className="fm-label">{t("newArtifact.nameLabel")}</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("newArtifact.namePlaceholder")} />
        </div>
        <div className="fm-field">
          <label className="fm-label">{t("newArtifact.descriptionLabel")}</label>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t("newArtifact.descriptionPlaceholder")}
          />
        </div>
        <div className="dialog-row">
          <button onClick={onCancel}>{t("common.cancel")}</button>
          <button className="primary" onClick={submit} disabled={!name.trim() || busy}>
            {t("common.create")}
          </button>
        </div>
      </div>
    </div>
  );
}
