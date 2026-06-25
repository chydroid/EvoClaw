#!/bin/sh
echo "Setting up git hooks..."
git config core.hooksPath .githooks
chmod +x .githooks/pre-commit
echo "Git hooks configured successfully!"
