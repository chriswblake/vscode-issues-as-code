#!/usr/bin/env bash
set -euo pipefail

echo ">>> Adjust workspace permissions..."
sudo chown -R node:node /workspaces

echo ">>> Installing dependencies..."
npm install

echo ">>> Compiling TypeScript..."
npm run compile

echo ">>> Done. Run 'npm run watch' to rebuild on changes, or press F5 in VS Code to launch the Extension Development Host."
