#!/bin/bash
# Setup git hooks for EvoClaw
# Run this script after cloning the repository

echo "Setting up git hooks..."

# Configure git to use .githooks directory
git config core.hooksPath .githooks

# Make hooks executable
chmod +x .githooks/pre-commit

echo "Git hooks configured successfully!"
echo ""
echo "Available hooks:"
echo "  - pre-commit: Checks for secrets and console.log"
