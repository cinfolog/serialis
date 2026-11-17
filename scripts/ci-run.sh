#!/usr/bin/env bash
# Runs a command; on failure, posts the end of its output as a GitHub annotation
# (annotations are readable from the check run, job logs are not always reachable).
# Usage: scripts/ci-run.sh <title> <command...>
title="$1"; shift
out=$("$@" 2>&1); code=$?
echo "$out"
if [ $code -ne 0 ]; then
  msg=$(printf '%s' "$out" | sed 's/\x1b\[[0-9;]*m//g' | tr '\n' ' ' | tail -c 700)
  echo "::error title=$title::$msg"
fi
exit $code
