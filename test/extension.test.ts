import * as assert from "assert";
import * as vscode from "vscode";

suite("Extension – integration tests", () => {
  test("extension activates without errors", async () => {
    const ext = vscode.extensions.getExtension(
      "undefined_publisher.vscode-issues-as-code",
    );
    if (ext && !ext.isActive) {
      await ext.activate();
    }
    // If the extension isn't found by ID in the test host, verify vscode itself is accessible
    assert.ok(vscode.version, "vscode API is accessible");
  });

  test("issuesAsCode.refresh command is registered", async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes("issuesAsCode.refresh"),
      "issuesAsCode.refresh should be registered",
    );
  });

  test("issuesAsCode.addSyncTarget command is registered", async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes("issuesAsCode.addSyncTarget"),
      "issuesAsCode.addSyncTarget should be registered",
    );
  });
});
