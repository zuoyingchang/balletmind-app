"""LangGraph port of BalletMind's "问问你的档案" hard-capped one-hop agent.

Same rules as the production version (server/ai/ask-prompt.js +
server/routes/progress.js), reimplemented with LangGraph instead of hand
-written Anthropic API calls:

  round 1 (free):  keyword search over the user's own records
  round 1 (paid):  model sees the matches, picks ONE of two tools —
                    submit_answer (done) or search_records (needs another,
                    differently-scoped search — typically a "this month vs
                    last month" style comparison)
  round 2 (paid, only if requested): re-run keyword search with the model's
                    own keywords + date range (clamped into the user's real
                    record range on both ends — see clamp_date_range below),
                    then the model is FORCED to submit_answer. No third
                    round is structurally possible.

Simple questions cost exactly 1 model call. Comparison questions cost
exactly 2. This mirrors the same cost-control story as the real feature.
"""
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, TypedDict

from langchain_anthropic import ChatAnthropic
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.graph import END, StateGraph
from pydantic import BaseModel, Field

from mock_records import MOCK_RECORDS, search_records_by_question

DAY_MS = 24 * 60 * 60 * 1000


# ---------------------------------------------------------------------------
# 1. Tools — same two tools, same rules, as SEARCH_RECORDS_TOOL / ASK_TOOL in
#    server/ai/ask-prompt.js. LangChain turns a Pydantic model's docstring +
#    field descriptions into the JSON schema Anthropic's tool-use API wants.
# ---------------------------------------------------------------------------
class SearchRecords(BaseModel):
    """当现有记录不够回答问题时（典型情况：需要对比两个不同时间段），在用户自己的训练记录里
    用新的关键词和/或日期范围再检索一次。最多调用一次。"""

    keywords: str = Field(description="检索关键词，可以跟用户原问题的措辞不同，比如提取出具体动作名")
    after: str = Field(default="", description="只找这个日期（含）之后的记录，格式 YYYY-MM-DD；不需要限制就留空")
    before: str = Field(default="", description="只找这个日期（含）之前的记录，格式 YYYY-MM-DD；不需要限制就留空")


class SubmitAnswer(BaseModel):
    """基于提供的训练记录，回答用户关于自己训练历史的问题"""

    answered: bool = Field(description="提供的记录是否足够回答这个问题")
    answer: str = Field(description="回答内容；涉及多个时间段对比时，只能并列列出各自写了什么，不得下\"进步/变差\"之类的结论")
    cited_record_ids: List[int] = Field(description="回答中实际引用到的记录编号")


# ---------------------------------------------------------------------------
# 2. Prompt building — same content as ask-prompt.js's SYSTEM_PROMPT_ASK /
#    userAskMessage, trimmed for the demo but keeping the load-bearing rules:
#    only answer from given records, no cross-record verdicts, today's date
#    must be stated explicitly (this is the fix for the real date-year bug).
# ---------------------------------------------------------------------------
SYSTEM_PROMPT = """你是一个帮用户查自己训练档案的助手，不是教练，不做诊断，不评价用户表现。
只能使用提供给你的记录内容来回答，不能使用你自己的芭蕾知识、不能编造记录里没有的内容。
不做跨记录的判断或总结性结论，比如不能说"你进步了""你一直没改善"——只能陈述记录里写了什么、什么时候写的。
对比不同时间段的问题，只能把各自写了什么并列列出，不得下"进步/退步"之类的结论，把判断完全留给用户自己看。
如果记录明显不够回答问题（最常见：问题在问两个不同时间段的对比，而现有记录只覆盖一个时间段），
可以调用 search_records 再查一次，日期范围必须以下面给出的"今天的日期"为基准换算，不要凭感觉猜年份。
只能调用一次，调用后必须给出最终回答。如果现有记录已经够回答，直接调用 submit_answer。"""


def _date_label(ts_ms: int) -> str:
    d = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc)
    return f"{d.year}年{d.month}月{d.day}日"


def _records_block(records: List[Dict[str, Any]]) -> str:
    if not records:
        return "（没有找到符合条件的记录）"
    parts = []
    for r in records:
        body = "\n".join(
            f"{label}：{r[key]}"
            for label, key in [("做得好的", "good_points"), ("待改进", "improve_points"), ("下次提醒", "next_time_reminder")]
            if r.get(key)
        )
        parts.append(f"[记录 {r['id']}｜{_date_label(r['created_at'])}｜{r.get('class_name', '训练记录')}]\n{body}")
    return "\n\n".join(parts)


def _user_message(question: str, records: List[Dict[str, Any]], today_label: str, date_range_label: str) -> str:
    return (
        f"今天的日期是：{today_label}\n"
        f"已检索到的记录（用户训练档案里日期最早到最晚是 {date_range_label}）：\n"
        f"<records>\n{_records_block(records)}\n</records>\n\n"
        f"用户的问题：{question}"
    )


def clamp_date_range(after: str, before: str, earliest_ts: int, latest_ts: int):
    """Both bounds clamped independently into the user's real record range —
    this is the fix for the live bug where the model guessed the wrong year
    (2024 instead of 2026) and an inverted, empty window silently matched
    nothing. See server/routes/progress.js clampDateRange for the original.
    """
    def parse(s):
        if not s:
            return None
        try:
            return int(datetime.strptime(s, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp() * 1000)
        except ValueError:
            return None

    parsed_after, parsed_before = parse(after), parse(before)
    after_ts = earliest_ts if parsed_after is None else min(max(parsed_after, earliest_ts), latest_ts)
    before_ts = latest_ts if parsed_before is None else max(min(parsed_before + DAY_MS - 1, latest_ts), earliest_ts)
    if after_ts > before_ts:
        after_ts, before_ts = earliest_ts, latest_ts
    return after_ts, before_ts


# ---------------------------------------------------------------------------
# 3. Graph state — everything the nodes read/write, threaded through the
#    whole run.
# ---------------------------------------------------------------------------
class AskState(TypedDict):
    question: str
    today_label: str
    date_range_label: str
    earliest_ts: int
    latest_ts: int
    round1_matches: List[Dict[str, Any]]
    round2_matches: List[Dict[str, Any]]
    all_matches: List[Dict[str, Any]]
    messages: List[Any]
    rounds: int
    answered: Optional[bool]
    answer: Optional[str]
    cited_ids: List[int]


llm = ChatAnthropic(model="claude-sonnet-5", max_tokens=1024)


# ---------------------------------------------------------------------------
# 4. Nodes
# ---------------------------------------------------------------------------
def node_round1_search(state: AskState) -> dict:
    """Free retrieval — no model call. Identical role to round1Matches in
    the real /api/progress/ask handler."""
    matches = search_records_by_question(MOCK_RECORDS, state["question"], top_n=3)
    return {"round1_matches": matches, "rounds": 0}


def node_round1_llm(state: AskState) -> dict:
    """First (and maybe only) model call. tool_choice='auto' is the ONE
    place any model autonomy lives — it can answer now or ask for one more
    search."""
    user_msg = _user_message(state["question"], state["round1_matches"], state["today_label"], state["date_range_label"])
    llm_with_tools = llm.bind_tools([SearchRecords, SubmitAnswer], tool_choice="auto")
    response = llm_with_tools.invoke([HumanMessage(content=user_msg)])
    return {
        "messages": [HumanMessage(content=user_msg), response],
        "rounds": 1,
        "all_matches": state["round1_matches"],
    }


def route_after_round1(state: AskState) -> str:
    """The conditional edge — this is where LangGraph enforces the branch
    that in the hand-written version was just an `if (toolUse1.name === ...)`
    check in progress.js."""
    last: AIMessage = state["messages"][-1]
    if not last.tool_calls:
        return "no_tool_use"
    return "round2_search" if last.tool_calls[0]["name"] == "SearchRecords" else "finalize"


def node_round2_search(state: AskState) -> dict:
    """Second (capped) retrieval, scoped by the model's own keywords/dates,
    clamped into the user's real record range."""
    tool_call = state["messages"][-1].tool_calls[0]
    args = tool_call["args"]
    after_ts, before_ts = clamp_date_range(
        args.get("after", ""), args.get("before", ""), state["earliest_ts"], state["latest_ts"]
    )
    scoped = [r for r in MOCK_RECORDS if after_ts <= r["created_at"] <= before_ts]
    round2 = search_records_by_question(scoped, args.get("keywords") or state["question"], top_n=3)
    seen_ids = {r["id"] for r in state["all_matches"]}
    merged = state["all_matches"] + [r for r in round2 if r["id"] not in seen_ids]
    return {"round2_matches": round2, "all_matches": merged}


def node_round2_llm(state: AskState) -> dict:
    """Forced final call — tool_choice pins SubmitAnswer, so this node is
    structurally incapable of asking for a third round."""
    tool_call = state["messages"][-1].tool_calls[0]
    tool_msg = ToolMessage(content=_records_block(state["round2_matches"]), tool_call_id=tool_call["id"])
    llm_forced = llm.bind_tools([SubmitAnswer], tool_choice="SubmitAnswer")
    messages = state["messages"] + [tool_msg]
    response = llm_forced.invoke(messages)
    return {"messages": messages + [response], "rounds": 2}


def node_finalize(state: AskState) -> dict:
    last: AIMessage = state["messages"][-1]
    args = last.tool_calls[0]["args"]
    cited = set(args.get("cited_record_ids", []))
    return {
        "answered": args.get("answered", False),
        "answer": args.get("answer", ""),
        "cited_ids": sorted(cited),
    }


def node_no_match(state: AskState) -> dict:
    """round1_matches came back empty — zero AI calls, same as the real
    handler's early return."""
    return {"answered": False, "answer": "档案里还没有找到相关记录。", "cited_ids": [], "rounds": 0}


def route_after_search(state: AskState) -> str:
    return "call_model" if state["round1_matches"] else "no_match"


# ---------------------------------------------------------------------------
# 5. Wire the graph together
# ---------------------------------------------------------------------------
def build_graph():
    g = StateGraph(AskState)
    g.add_node("round1_search", node_round1_search)
    g.add_node("round1_llm", node_round1_llm)
    g.add_node("round2_search", node_round2_search)
    g.add_node("round2_llm", node_round2_llm)
    g.add_node("finalize", node_finalize)
    g.add_node("no_match", node_no_match)

    g.set_entry_point("round1_search")
    g.add_conditional_edges("round1_search", route_after_search, {"call_model": "round1_llm", "no_match": "no_match"})
    g.add_conditional_edges(
        "round1_llm", route_after_round1, {"round2_search": "round2_search", "finalize": "finalize", "no_tool_use": END}
    )
    g.add_edge("round2_search", "round2_llm")
    g.add_edge("round2_llm", "finalize")
    g.add_edge("finalize", END)
    g.add_edge("no_match", END)
    return g.compile()


def ask(question: str) -> dict:
    earliest_ts = min(r["created_at"] for r in MOCK_RECORDS)
    latest_ts = max(r["created_at"] for r in MOCK_RECORDS)
    today = datetime.now(tz=timezone.utc)
    initial_state: AskState = {
        "question": question,
        "today_label": f"{today.year}年{today.month}月{today.day}日",
        "date_range_label": f"{_date_label(earliest_ts)} ~ {_date_label(latest_ts)}",
        "earliest_ts": earliest_ts,
        "latest_ts": latest_ts,
        "round1_matches": [],
        "round2_matches": [],
        "all_matches": [],
        "messages": [],
        "rounds": 0,
        "answered": None,
        "answer": None,
        "cited_ids": [],
    }
    app = build_graph()
    result = app.invoke(initial_state)
    return {
        "rounds": result["rounds"],
        "answered": result["answered"],
        "answer": result["answer"],
        "cited_ids": result["cited_ids"],
    }
