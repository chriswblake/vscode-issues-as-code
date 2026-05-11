import * as assert from "assert";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import {
  serializeIssueFile,
  readIssueFile,
  writeIssueFile,
  type IssueFrontmatter,
} from "../src/fileManager";
import {
  matchesFilter,
  buildFileName,
  type GhIssuesFilters,
} from "../src/plugins/ghIssuesPlugin";

// ---------------------------------------------------------------------------
// Section 1: buildFileName
// ---------------------------------------------------------------------------
suite("ghIssuesPlugin – buildFileName", () => {
  function makeTokens(
    number: number,
    title: string,
  ): Record<string, string | number> {
    return { "gh-issues.number": number, "gh-issues.title": title };
  }

  test("produces expected filename from token template", () => {
    const result = buildFileName(
      makeTokens(42, "Fix the bug"),
      "{gh-issues.number}-{gh-issues.title}",
    );
    assert.strictEqual(result, "42-fix-the-bug");
  });

  test("strips characters invalid in filenames", () => {
    const result = buildFileName(
      makeTokens(1, "Hello: world / test"),
      "{gh-issues.number}-{gh-issues.title}",
    );
    assert.ok(!result.includes("/"), "should not contain /");
    assert.ok(!result.includes(":"), "should not contain :");
  });

  test("collapses consecutive dashes", () => {
    const result = buildFileName(
      makeTokens(3, "A   B   C"),
      "{gh-issues.number}-{gh-issues.title}",
    );
    assert.ok(!result.includes("--"), "should not have consecutive dashes");
  });

  test("lowercases title slug", () => {
    const result = buildFileName(
      makeTokens(7, "UPPER CASE TITLE"),
      "{gh-issues.number}-{gh-issues.title}",
    );
    assert.strictEqual(result, "7-upper-case-title");
  });

  test("handles custom template with number only", () => {
    const result = buildFileName(
      makeTokens(99, "my task"),
      "issue-{gh-issues.number}",
    );
    assert.strictEqual(result, "issue-99");
  });
});

// ---------------------------------------------------------------------------
// Section 2: matchesFilter
// ---------------------------------------------------------------------------
suite("fileManager – matchesFilter", () => {
  function makeFrontmatter(
    overrides: Partial<{
      state: "open" | "closed";
      labels: string[];
      assignees: string[];
    }> = {},
  ): IssueFrontmatter {
    return {
      "gh-issues": {
        number: 1,
        title: "Test",
        state: overrides.state ?? "open",
        labels: overrides.labels ?? [],
        assignees: overrides.assignees ?? [],
      },
    };
  }

  function makeFilters(
    overrides: Partial<GhIssuesFilters> = {},
  ): GhIssuesFilters {
    return { repository: "owner/repo", ...overrides };
  }

  test("state:open matches open issue", () => {
    const fm = makeFrontmatter({ state: "open" });
    assert.strictEqual(matchesFilter(fm, makeFilters({ state: "open" })), true);
  });

  test("state:open does not match closed issue", () => {
    const fm = makeFrontmatter({ state: "closed" });
    assert.strictEqual(
      matchesFilter(fm, makeFilters({ state: "open" })),
      false,
    );
  });

  test("state:closed matches closed issue", () => {
    const fm = makeFrontmatter({ state: "closed" });
    assert.strictEqual(
      matchesFilter(fm, makeFilters({ state: "closed" })),
      true,
    );
  });

  test("label filter matches when label present", () => {
    const fm = makeFrontmatter({ labels: ["bug", "help wanted"] });
    assert.strictEqual(matchesFilter(fm, makeFilters({ label: "bug" })), true);
  });

  test("label filter does not match when label absent", () => {
    const fm = makeFrontmatter({ labels: ["enhancement"] });
    assert.strictEqual(matchesFilter(fm, makeFilters({ label: "bug" })), false);
  });

  test("label array filter: all labels must be present", () => {
    const fm = makeFrontmatter({ labels: ["bug", "help wanted"] });
    assert.strictEqual(
      matchesFilter(fm, makeFilters({ label: ["bug", "help wanted"] })),
      true,
    );
    assert.strictEqual(
      matchesFilter(fm, makeFilters({ label: ["bug", "missing"] })),
      false,
    );
  });

  test("assignee filter matches when assignee present", () => {
    const fm = makeFrontmatter({ assignees: ["octocat"] });
    assert.strictEqual(
      matchesFilter(fm, makeFilters({ assignee: "octocat" })),
      true,
    );
  });

  test("assignee filter does not match when assignee absent", () => {
    const fm = makeFrontmatter({ assignees: [] });
    assert.strictEqual(
      matchesFilter(fm, makeFilters({ assignee: "octocat" })),
      false,
    );
  });

  test("filters with only repository field always match", () => {
    const fm = makeFrontmatter();
    assert.strictEqual(matchesFilter(fm, makeFilters()), true);
  });

  test("returns false when gh-issues namespace is missing from frontmatter", () => {
    const fm: IssueFrontmatter = {};
    assert.strictEqual(
      matchesFilter(fm, makeFilters({ state: "open" })),
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Section 3: serializeIssueFile / readIssueFile round-trip
// ---------------------------------------------------------------------------
suite("fileManager – serialize/read round-trip", () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue-test-"));
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeFrontmatter(): IssueFrontmatter {
    return {
      "gh-issues": {
        number: 5,
        title: "My task",
        state: "open",
        labels: ["bug", "help wanted"],
        assignees: ["octocat"],
      },
    };
  }

  test("serializeIssueFile produces YAML frontmatter with gh-issues namespace", () => {
    const fm = makeFrontmatter();
    const result = serializeIssueFile(fm, "Issue body here.");
    assert.ok(result.startsWith("---"), "should start with ---");
    assert.ok(
      result.includes("gh-issues:"),
      "should include gh-issues namespace",
    );
    assert.ok(result.includes("title: My task"), "should include title");
    assert.ok(result.includes("Issue body here."), "should include body");
  });

  test("readIssueFile round-trips through writeIssueFile", async () => {
    const fm = makeFrontmatter();
    const body = "Issue body goes here.";
    const filePath = path.join(tmpDir, "test-issue.md");

    await writeIssueFile(filePath, fm, body);
    const { frontmatter: read, body: readBody } = await readIssueFile(filePath);

    const ghIssues = read["gh-issues"] as Record<string, unknown>;
    assert.strictEqual(ghIssues.number, 5);
    assert.strictEqual(ghIssues.title, "My task");
    assert.strictEqual(ghIssues.state, "open");
    assert.deepStrictEqual(ghIssues.labels, ["bug", "help wanted"]);
    assert.deepStrictEqual(ghIssues.assignees, ["octocat"]);
    assert.ok(readBody.includes("Issue body goes here."));
  });

  test("readIssueFile handles missing optional fields gracefully", async () => {
    const filePath = path.join(tmpDir, "minimal.md");
    const content =
      "---\ngh-issues:\n  title: Minimal\n  state: open\n---\nBody text.\n";
    await fs.promises.writeFile(filePath, content, "utf8");

    const { frontmatter, body } = await readIssueFile(filePath);
    const ghIssues = frontmatter["gh-issues"] as Record<string, unknown>;
    assert.strictEqual(ghIssues.title, "Minimal");
    assert.strictEqual(ghIssues.state, "open");
    assert.ok(body.includes("Body text."));
  });

  test("readIssueFile parses gh-projects namespace if present", async () => {
    const filePath = path.join(tmpDir, "with-projects.md");
    const content =
      "---\ngh-issues:\n  title: T\n  state: open\ngh-projects:\n  title: T\n  field1: val1\n---\nbody\n";
    await fs.promises.writeFile(filePath, content, "utf8");

    const { frontmatter } = await readIssueFile(filePath);
    assert.ok(
      frontmatter["gh-projects"],
      "gh-projects namespace should be present",
    );
    assert.strictEqual(
      (frontmatter["gh-projects"] as Record<string, unknown>)["field1"],
      "val1",
    );
  });
});
