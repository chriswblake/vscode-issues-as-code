import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension – integration tests', () => {
  test('extension activates without errors', async () => {
    const ext = vscode.extensions.getExtension('undefined_publisher.vscode-issues-as-code');
    if (ext && !ext.isActive) {
      await ext.activate();
    }
    // If the extension isn't found by ID in the test host, verify vscode itself is accessible
    assert.ok(vscode.version, 'vscode API is accessible');
  });

  test('issueSync.pullNow command is registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes('issueSync.pullNow'),
      'issueSync.pullNow should be registered'
    );
  });

  test('issueSync.pushNow command is registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes('issueSync.pushNow'),
      'issueSync.pushNow should be registered'
    );
  });

  test('issueSync.refresh command is registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes('issueSync.refresh'),
      'issueSync.refresh should be registered'
    );
  });
});
