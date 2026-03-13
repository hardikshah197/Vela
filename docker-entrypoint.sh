#!/bin/bash
set -e

echo "[Vela] Starting backend server..."
node server.js &
BACKEND_PID=$!

echo "[Vela] Starting frontend static server..."
npx serve dist -l 5173 -s &
FRONTEND_PID=$!

echo "[Vela] Backend  → http://localhost:3001"
echo "[Vela] Frontend → http://localhost:5173"

# Wait for either process to exit
wait -n
exit $?
