import { useApp } from "../lib/store";
import { PermissionsEditor } from "./PermissionsEditor";
import { HooksEditor } from "./HooksEditor";
import { McpEditor } from "./McpEditor";
import { KeybindingsEditor } from "./KeybindingsEditor";

interface Props {
  onToast?: (kind: "ok" | "error", text: string) => void;
}

// Wrapper that swaps in the right editor based on configKind. Subsequent
// slices add HooksEditor/McpEditor/KeybindingsEditor to this switch.
export function ConfigsPanel({ onToast }: Props) {
  const configKind = useApp((s) => s.configKind);

  switch (configKind) {
    case "permissions":
      return <PermissionsEditor onToast={onToast} />;
    case "hooks":
      return <HooksEditor onToast={onToast} />;
    case "mcp":
      return <McpEditor onToast={onToast} />;
    case "keybindings":
      return <KeybindingsEditor onToast={onToast} />;
  }
}
