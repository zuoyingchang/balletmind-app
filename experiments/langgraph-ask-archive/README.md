# LangGraph port of "问问你的档案" (ask-your-archive)

A from-scratch Python/LangGraph reimplementation of the hand-written
Anthropic tool-use agent in `server/ai/ask-prompt.js` +
`server/routes/progress.js`, built to get real hands-on LangGraph
experience against a system I'd already designed and shipped — not a
tutorial project.

Same rules, same hard cap, different plumbing:

- Round 1 is a free keyword search (no model call) over the user's own
  confirmed training records.
- The model sees round 1's matches and picks exactly one of two tools:
  `submit_answer` (done — 1 model call total) or `search_records`
  (needs one more, differently-scoped search — typically a "this month
  vs last month" comparison; 2 model calls total).
- Round 2's `tool_choice` is forced to `submit_answer`, so a third round
  is structurally impossible, not just discouraged by prompt wording.

This folder is intentionally **not** wired into the running app (nothing
under `server/` imports it, and it's plain scripts, not part of the
Express server). It exists to compare the same architecture across a
hand-written implementation and a graph-based one — see the main
project's conversation history for the full writeup of what carried
over 1:1 (the `tool_choice` auto/forced split) versus what LangGraph
made explicit that used to be implicit in the JS version (state and
branching, expressed as nodes + conditional edges instead of an
`if` in the middle of a route handler).

## Run it

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...
python run_demo.py
```

## Files

- `mock_records.py` — sample training records + a Python port of the
  sliding-window CJK bigram keyword search from
  `public/js/ballet-terms.js` (same fix for the chunk-boundary bug: a
  non-overlapping split can miss a term straddling a chunk edge).
- `ask_archive_graph.py` — the LangGraph state machine: tool schemas,
  prompt building, `clamp_date_range` (ported from `progress.js`, same
  fix for the real live bug where an unclamped bound could invert the
  search window into an empty range), nodes, and the graph wiring.
- `run_demo.py` — runs two real questions against the real Anthropic
  API and prints rounds/answer/citations for each.
