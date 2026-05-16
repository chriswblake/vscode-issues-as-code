// ---------------------------------------------------------------------------
// Line diffing and conflict marker generation
// ---------------------------------------------------------------------------

export type DiffLine = { type: "equal" | "added" | "removed"; line: string };

/** LCS-based line diff. 'added' = in cloud only, 'removed' = in local only. */
export function computeLineDiff(
  localLines: string[], //
  cloudLines: string[],
): DiffLine[] {
  const m = localLines.length;
  const n = cloudLines.length;

  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0),
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (localLines[i] === cloudLines[j]) {
        dp[i][j] = 1 + dp[i + 1][j + 1];
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (localLines[i] === cloudLines[j]) {
      result.push({ type: "equal", line: localLines[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ type: "removed", line: localLines[i] });
      i++;
    } else {
      result.push({ type: "added", line: cloudLines[j] });
      j++;
    }
  }
  while (i < m) {
    result.push({ type: "removed", line: localLines[i++] });
  }
  while (j < n) {
    result.push({ type: "added", line: cloudLines[j++] });
  }

  return result;
}

/** Returns whether a cloud→local change is additions-only, removals-only, mixed, or identical. */
export function classifyDiff(
  localContent: string, //
  cloudContent: string,
): "identical" | "additions-only" | "removals-only" | "mixed" {
  const diff = computeLineDiff(
    localContent.split(/\r?\n/),
    cloudContent.split(/\r?\n/),
  );

  let hasAdditions = false;
  let hasRemovals = false;
  for (const item of diff) {
    if (item.type === "added") hasAdditions = true;
    if (item.type === "removed") hasRemovals = true;
  }

  if (!hasAdditions && !hasRemovals) return "identical";
  if (hasAdditions && !hasRemovals) return "additions-only";
  if (!hasAdditions && hasRemovals) return "removals-only";
  return "mixed";
}

/** Produces file content with standard merge conflict markers for all diff hunks. */
export function generateConflictContent(
  localContent: string, //
  cloudContent: string,
): string {
  const diff = computeLineDiff(
    localContent.split(/\r?\n/),
    cloudContent.split(/\r?\n/),
  );

  const output: string[] = [];
  let i = 0;
  while (i < diff.length) {
    if (diff[i].type === "equal") {
      output.push(diff[i].line);
      i++;
    } else {
      // Collect a contiguous conflict hunk
      const localSection: string[] = [];
      const cloudSection: string[] = [];
      while (i < diff.length && diff[i].type !== "equal") {
        if (diff[i].type === "removed") localSection.push(diff[i].line);
        else cloudSection.push(diff[i].line);
        i++;
      }
      output.push("<<<<<<< Local");
      output.push(...localSection);
      output.push("=======");
      output.push(...cloudSection);
      output.push(">>>>>>> Remote");
    }
  }

  return output.join("\n");
}

/** Returns true if the file content contains unresolved merge conflict markers. */
export function hasConflictMarkers(content: string): boolean {
  return /^<{7} /m.test(content);
}
