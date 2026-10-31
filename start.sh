#!/usr/bin/env bash
# linux / macos / android (termux): start the bot in the background.
# logs: tail -f bot.log   |   stop: bash stop.sh
cd "$(dirname "$0")" || exit 1

if [ -f bot.pid ] && kill -0 "$(cat bot.pid)" 2>/dev/null; then
  echo "bot already running (pid $(cat bot.pid))"
  exit 0
fi
mkdir -p bridge/inbox bridge/outbox

nohup bash -c 'while true; do node bot.js >> bot.log 2>&1; echo "=== bot exited $(date), restarting in 5s ===" >> bot.log; sleep 5; done' >/dev/null 2>&1 &
echo $! > bot.pid
echo "bot started in background (pid $(cat bot.pid))"
echo "logs: tail -f bot.log  |  stop: bash stop.sh"
