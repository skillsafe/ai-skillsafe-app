import { describe, expect, it } from "vitest";
import { scanFiles, type FileEntry } from "../src/lib/scan/scanner";

function file(path: string, content: string): FileEntry {
  return { path, content, size: content.length };
}

describe("secret_path_* scanner pass", () => {
  it("flags .env references in SKILL.md", () => {
    const result = scanFiles([file("SKILL.md", "Source the project .env file before running.\n")]);
    const ids = result.raw_findings.map((f) => f.rule_id);
    expect(ids).toContain("secret_path_dotenv");
  });

  it("flags ~/.aws/credentials reads", () => {
    const result = scanFiles([file("SKILL.md", "cat ~/.aws/credentials | aws configure\n")]);
    const ids = result.raw_findings.map((f) => f.rule_id);
    expect(ids).toContain("secret_path_aws");
  });

  it("flags SSH private key references", () => {
    const result = scanFiles([file("scripts/setup.sh", "ssh -i ~/.ssh/id_rsa user@host\n")]);
    const ids = result.raw_findings.map((f) => f.rule_id);
    expect(ids).toContain("secret_path_ssh_key");
  });

  it("flags kube config reference", () => {
    const result = scanFiles([file("SKILL.md", "kubectl --kubeconfig=~/.kube/config\n")]);
    const ids = result.raw_findings.map((f) => f.rule_id);
    expect(ids).toContain("secret_path_kube");
  });

  it("flags GCP service-account JSON", () => {
    const result = scanFiles([file("SKILL.md", "gcloud auth activate-service-account --key-file=./service-account.json\n")]);
    const ids = result.raw_findings.map((f) => f.rule_id);
    expect(ids).toContain("secret_path_gcp");
  });

  it("does not fire on harmless content", () => {
    const result = scanFiles([file("SKILL.md", "Just a regular markdown file with no secrets.\n")]);
    const ids = result.raw_findings.map((f) => f.rule_id);
    expect(ids.some((id) => id.startsWith("secret_path_"))).toBe(false);
  });
});
