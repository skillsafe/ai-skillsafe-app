import { sha256Hex } from "../fs";

export async function pathKey(absPath: string): Promise<string> {
  return sha256Hex(absPath);
}
