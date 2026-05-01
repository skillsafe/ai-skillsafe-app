import { useState } from "react";

interface Props {
  onCancel: () => void;
  onCreate: (name: string, description: string) => Promise<void>;
}

export function NewArtifactDialog({ onCancel, onCreate }: Props) {
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
        <h3>New artifact</h3>
        <div className="fm-field">
          <label className="fm-label">name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-skill" />
        </div>
        <div className="fm-field">
          <label className="fm-label">description</label>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="When the agent should reach for this"
          />
        </div>
        <div className="dialog-row">
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={submit} disabled={!name.trim() || busy}>
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
