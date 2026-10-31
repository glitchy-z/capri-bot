#!/usr/bin/env bash
# stop the background bot started by start.sh
cd "$(dirname "$0")" || exit 1

if [ -f bot.pid ]; then
  PID=$(cat bot.pid)
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    pkill -P "$PID" 2>/dev/null   # the node child
    kill "$PID" 2>/dev/null       # the restart loop
  fi
  rm -f bot.pid
fi
pkill -f "node bot.js" 2>/dev/null
echo "bot stopped"
