"""A 3-agent LangGraph pipeline (分析 -> 写作 -> 审核) that turns the real
recurring-issue data from server/issues.js into a natural-language
pre-class reminder ("课前三句提醒").

This is NOT a production upgrade. The real /api/progress/brief endpoint
(server/routes/progress.js) deliberately renders the top issues with ZERO
LLM calls — same "AI不替用户下结论" philosophy as issues.js's containment
matcher. That's a good design choice for the shipped feature: no model in
the loop means no hallucination risk for something users see every time
they open the app. This pipeline is a separate exploration of what an
LLM-assisted version *could* look like, built to practice a multi-agent
pattern the ask-archive port didn't use: a CYCLE (reviewer can bounce
work back to the writer), not just a one-way branch.

Roles, and why each one is a genuinely separate agent rather than one
prompt doing everything:

  分析 Agent  - groups/prioritizes the raw issues. The real matcher in
                issues.js only does containment matching (`na.includes(nb)`),
                so "转圈时骨盆晃" and "核心力量不够" never merge even though
                they're the same underlying theme. Semantic grouping is
                exactly what containment matching can't do — genuine value
                add, not a rewrite of existing logic.
  写作 Agent  - drafts the actual reminder text. Production does zero
                writing today (raw issue.text gets listed as-is); this
                agent turns terse fragments into a short, readable card.
  审核 Agent  - enforces the product's core rule (no "你进步了/你一直没
                改善" verdicts, every claim must cite a real issue id, cap
                at 3 items). If it rejects, the graph loops back to 写作
                with feedback attached — bounded to 2 attempts, then falls
                back to a zero-LLM templated message built straight from
                the raw issue text. That fallback mirrors the real
                endpoint's own "0 LLM calls, always show something" spirit.
"""
from typing import Any, Dict, List, Optional, TypedDict

from langchain_anthropic import ChatAnthropic
from langchain_core.messages import HumanMessage
from langgraph.graph import END, StateGraph
from pydantic import BaseModel, Field

from mock_issues import MOCK_ISSUES

MAX_WRITE_ATTEMPTS = 2


# ---------------------------------------------------------------------------
# 1. Tool schemas for the analyst and reviewer. The writer is a plain text
#    completion (no tool) since its job is prose, not structured data.
# ---------------------------------------------------------------------------
class IssueTheme(BaseModel):
    """一个课前提醒的主题：可能对应一条或多条原始问题记录"""

    theme_label: str = Field(description="这个主题的简短说法，给用户看的")
    issue_ids: List[int] = Field(description="属于这个主题的原始问题 id，必须来自输入里给的 issues")
    reason: str = Field(description="为什么把这些 issue 归为一类，内部用，不给用户看")


class IssueAnalysis(BaseModel):
    """把原始问题列表分析、归类、按优先级排序，最多给出 3 个主题"""

    themes: List[IssueTheme] = Field(description="按优先级从高到低排序，最多 3 个")


class ReviewVerdict(BaseModel):
    """检查课前提醒草稿是否符合规则"""

    approved: bool = Field(description="草稿是否合格，可以直接展示给用户")
    feedback: str = Field(description="不合格的具体原因和修改建议；合格则留空")
    cited_issue_ids: List[int] = Field(description="草稿里实际引用到的原始问题 id")


# ---------------------------------------------------------------------------
# 2. Prompt building
# ---------------------------------------------------------------------------
ANALYST_SYSTEM_PROMPT = """你在帮一个芭蕾训练记录类产品分析用户"反复出现的问题"数据，
目的是生成一张课前提醒卡。只能使用提供的 issue 列表内容，不能编造列表之外的问题。
把意思相近但文字不同的问题归为同一个主题（比如"重心不稳"和"核心力量不够"如果都指向同一件事）。
按对用户上课最有帮助的优先级排序，最多给 3 个主题。不做进步/退步之类的判断，只做归类和排序。"""

WRITER_SYSTEM_PROMPT = """你在帮一个芭蕾训练记录类产品把分析好的问题主题写成课前提醒。
要求：
- 最多 3 条，每条一句话，口语化、给用户看的，不是内部标签
- 只能使用给你的主题和原始问题内容，不能编造建议或加入芭蕾知识
- 不能出现"你进步了""你一直没改善""你退步了"之类的判断性结论，只能提醒"这个问题最近常出现"
- 如果收到了审核反馈，必须按反馈修改"""

REVIEWER_SYSTEM_PROMPT = """你在审核一张课前提醒卡的草稿，必须调用 ReviewVerdict 给出结论。
拒绝的情况：
- 出现"进步了/退步了/一直没改善"之类的判断性结论
- 提到了原始 issues 里没有的内容（编造）
- 超过 3 条
其余情况批准。feedback 要具体到哪一句话有问题、该怎么改，方便重写。"""


def _issues_block(issues: List[Dict[str, Any]]) -> str:
    parts = []
    for i in issues:
        parts.append(f"[issue {i['id']}] {i['text']}（出现 {i['occurrence_count']} 次）")
    return "\n".join(parts)


def _themes_block(themes: List[Dict[str, Any]]) -> str:
    parts = []
    for t in themes:
        parts.append(f"- {t['theme_label']}（关联 issue: {t['issue_ids']}）")
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# 3. Graph state
# ---------------------------------------------------------------------------
class BriefState(TypedDict):
    issues: List[Dict[str, Any]]
    analysis: Optional[Dict[str, Any]]
    draft: Optional[str]
    review_feedback: Optional[str]
    attempts: int
    approved: bool
    final_text: Optional[str]
    used_fallback: bool


llm = ChatAnthropic(model="claude-sonnet-5", max_tokens=1024)


# ---------------------------------------------------------------------------
# 4. Nodes
# ---------------------------------------------------------------------------
def node_analyze(state: BriefState) -> dict:
    llm_forced = llm.bind_tools([IssueAnalysis], tool_choice="IssueAnalysis")
    msg = f"原始问题列表：\n{_issues_block(state['issues'])}"
    response = llm_forced.invoke([HumanMessage(content=ANALYST_SYSTEM_PROMPT + "\n\n" + msg)])
    args = response.tool_calls[0]["args"]
    return {"analysis": args}


def node_write(state: BriefState) -> dict:
    parts = [
        WRITER_SYSTEM_PROMPT,
        f"主题（已按优先级排序）：\n{_themes_block(state['analysis']['themes'])}",
        f"原始问题列表（可引用具体措辞）：\n{_issues_block(state['issues'])}",
    ]
    if state.get("review_feedback"):
        parts.append(f"上一版被驳回，审核反馈：{state['review_feedback']}")
    response = llm.invoke([HumanMessage(content="\n\n".join(parts))])
    return {"draft": response.content, "attempts": state["attempts"] + 1}


def node_review(state: BriefState) -> dict:
    llm_forced = llm.bind_tools([ReviewVerdict], tool_choice="ReviewVerdict")
    msg = (
        f"原始问题列表：\n{_issues_block(state['issues'])}\n\n"
        f"课前提醒草稿：\n{state['draft']}"
    )
    response = llm_forced.invoke([HumanMessage(content=REVIEWER_SYSTEM_PROMPT + "\n\n" + msg)])
    args = response.tool_calls[0]["args"]
    return {"approved": args["approved"], "review_feedback": args.get("feedback", "")}


def route_after_review(state: BriefState) -> str:
    if state["approved"]:
        return "finalize"
    if state["attempts"] < MAX_WRITE_ATTEMPTS:
        return "rewrite"
    return "fallback"


def node_finalize(state: BriefState) -> dict:
    return {"final_text": state["draft"], "used_fallback": False}


def node_fallback(state: BriefState) -> dict:
    """Zero-LLM safety net — same spirit as the real /api/progress/brief
    endpoint: if we can't confidently produce a written brief, fall back to
    just listing the raw top issues rather than risk showing a bad draft."""
    top = sorted(state["issues"], key=lambda i: -i["occurrence_count"])[:3]
    lines = [f"- {i['text']}（出现 {i['occurrence_count']} 次）" for i in top]
    return {"final_text": "\n".join(lines), "used_fallback": True}


# ---------------------------------------------------------------------------
# 5. Wire the graph together — this is the cyclic part: review -> rewrite
#    loops back to the write node instead of only branching forward.
# ---------------------------------------------------------------------------
def build_graph():
    g = StateGraph(BriefState)
    g.add_node("analyze", node_analyze)
    g.add_node("write", node_write)
    g.add_node("review", node_review)
    g.add_node("finalize", node_finalize)
    g.add_node("fallback", node_fallback)

    g.set_entry_point("analyze")
    g.add_edge("analyze", "write")
    g.add_edge("write", "review")
    g.add_conditional_edges(
        "review", route_after_review, {"finalize": "finalize", "rewrite": "write", "fallback": "fallback"}
    )
    g.add_edge("finalize", END)
    g.add_edge("fallback", END)
    return g.compile()


def generate_brief(issues: Optional[List[Dict[str, Any]]] = None) -> dict:
    initial_state: BriefState = {
        "issues": issues if issues is not None else MOCK_ISSUES,
        "analysis": None,
        "draft": None,
        "review_feedback": None,
        "attempts": 0,
        "approved": False,
        "final_text": None,
        "used_fallback": False,
    }
    app = build_graph()
    result = app.invoke(initial_state)
    return {
        "themes": result["analysis"]["themes"],
        "attempts": result["attempts"],
        "used_fallback": result["used_fallback"],
        "final_text": result["final_text"],
    }
