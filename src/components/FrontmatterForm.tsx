import type { ArtifactType, Tool } from "../lib/artifacts/types";
import { describeFields, validate } from "../lib/validate";

interface Props {
  tool: Tool;
  type: ArtifactType;
  value: Record<string, unknown>;
  onChange: (v: Record<string, unknown>) => void;
}

export function FrontmatterForm({ tool, type, value, onChange }: Props) {
  const fields = describeFields(tool, type);
  const result = validate(tool, type, value);
  const errorByPath = new Map(result.errors.map((e) => [e.path, e.message]));

  function setField(name: string, raw: unknown) {
    const next = { ...value };
    if (raw === "" || raw === undefined) {
      delete next[name];
    } else {
      next[name] = raw;
    }
    onChange(next);
  }

  return (
    <div className="fm-form">
      {fields.map((f) => {
        const current = value[f.name];
        const error = errorByPath.get(f.name);
        return (
          <div className="fm-field" key={f.name}>
            <label className="fm-label">
              {f.name}
              {f.required && " *"}
            </label>
            {f.kind === "boolean" ? (
              <select
                value={current === true ? "true" : current === false ? "false" : ""}
                onChange={(e) => {
                  const v = e.target.value;
                  setField(f.name, v === "" ? undefined : v === "true");
                }}
              >
                <option value="">—</option>
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            ) : f.kind === "string[]" ? (
              <input
                value={Array.isArray(current) ? current.join(", ") : (current as string) ?? ""}
                placeholder="comma-separated"
                onChange={(e) => {
                  const raw = e.target.value;
                  if (!raw.trim()) setField(f.name, undefined);
                  else if (raw.includes(",")) {
                    setField(
                      f.name,
                      raw
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean),
                    );
                  } else setField(f.name, raw);
                }}
              />
            ) : (
              <input
                value={(current as string) ?? ""}
                onChange={(e) => setField(f.name, e.target.value)}
              />
            )}
            {error && <div className="fm-error">{error}</div>}
          </div>
        );
      })}
    </div>
  );
}
