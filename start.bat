@echo off
chcp 65001 > nul
echo Starting EcoClaw Server...
node --env-file=.env apps/server/dist/index.js