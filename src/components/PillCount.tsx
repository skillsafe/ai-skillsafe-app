import type { ReactElement } from "react";

interface PillCountProps {
  /** Render the badge only when count is a number; passing null hides it. */
  count: number | null | undefined;
}

export function PillCount({ count }: PillCountProps): ReactElement | null {
  if (count === null || count === undefined) return null;
  const empty = count === 0;
  return (
    <span className={`pill-count${empty ? " pill-count--empty" : ""}`} aria-hidden="true">
      {count}
    </span>
  );
}
