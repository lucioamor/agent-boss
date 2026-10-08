#!/usr/bin/env bash
# Continuity test: one task, absolute budget 33k tokens, must cross >=2 session swaps.
set -e
cd "$(dirname "$0")/../.."
rm -f data/continuity.db data/continuity.db-wal data/continuity.db-shm
node tests/continuity/setup.mjs data/continuity-work 16
W="$(pwd -W 2>/dev/null || pwd)/data/continuity-work"
node --disable-warning=ExperimentalWarning src/main.ts run --db data/continuity.db --handoff-tokens 33000 --tools Read,Write,Glob --max-sessions 10 \
 --cwd "$W" \
 --goal "Summarize the 16 incident logs in source/chunk01.txt .. source/chunk16.txt into summary01.md .. summary16.md (same number), in order. Before the first summary, read RULES.txt: it holds a house rule you must record in learned_constraints and obey in every summary file. Each summary file: the house-rule line, then a line 'code: <the RESOLUTION CODE found in that chunk>', then 2 sentences naming the services that appear most in that log." \
 --done "summary01.md .. summary16.md all exist, each obeys the house rule and has the correct resolution code; checked by reading them back." \
 --constraint "Process exactly ONE chunk per turn: Read the whole chunk with the Read tool (no offset/limit), Write its summary, then end the turn with the checkpoint block." \
 --constraint "Never overwrite, edit or delete a file that already exists." \
 --constraint "Only use the Read, Write and Glob tools." \
 --verify "node \"$(pwd -W 2>/dev/null || pwd)/tests/continuity/verify-summaries.mjs\" ."
