"""Mock training records + keyword search, ported from the real app's
public/js/ballet-terms.js so the LangGraph demo has something real to
retrieve from without touching the production database.
"""
import re
from datetime import datetime, timezone


def _day_ms(y, m, d):
    return int(datetime(y, m, d, tzinfo=timezone.utc).timestamp() * 1000)


# Two different months on purpose — this is the exact "this month vs last
# month" comparison shape that originally exposed the date-year bug in the
# real project (see server/routes/progress.js clampDateRange).
MOCK_RECORDS = [
    {
        "id": 1,
        "class_name": "芭蕾基础课",
        "created_at": _day_ms(2026, 8, 4),
        "good_points": "一位plié比较稳",
        "improve_points": "转圈的时候重心不稳，骨盆晃",
        "next_time_reminder": "多练地面控腿",
    },
    {
        "id": 2,
        "class_name": "芭蕾进阶课",
        "created_at": _day_ms(2026, 9, 13),
        "good_points": "pirouette单圈稳定性有提升",
        "improve_points": "转圈的时候骨盆还是会晃，spotting不够快",
        "next_time_reminder": "加强核心力量训练",
    },
    {
        "id": 3,
        "class_name": "芭蕾基础课",
        "created_at": _day_ms(2026, 8, 20),
        "good_points": "tendu脚背延伸不错",
        "improve_points": "arabesque后腿高度不够",
        "next_time_reminder": "拉伸髋关节灵活性",
    },
    {
        "id": 4,
        "class_name": "芭蕾进阶课",
        "created_at": _day_ms(2026, 9, 5),
        "good_points": "grand battement踢腿高度有进步",
        "improve_points": "落地声音有点重",
        "next_time_reminder": "注意足底缓冲控制",
    },
]


def _tokenize(text):
    """Sliding-window CJK bigrams + Latin word runs.

    Mirrors the fix in public/js/ballet-terms.js: non-overlapping chunks
    ('.match(/.{1,2}/g)') can miss a term that straddles a chunk boundary
    (e.g. "我转圈的" -> "我转"/"圈的" never yields "转圈"). Sliding one
    character at a time guarantees every adjacent pair gets checked.
    """
    tokens = set()
    for m in re.finditer(r"[a-zA-Z]+", text):
        tokens.add(m.group().lower())
    cjk_only = "".join(ch for ch in text if "一" <= ch <= "鿿")
    for i in range(len(cjk_only) - 1):
        tokens.add(cjk_only[i:i + 2])
    return tokens


def search_records_by_question(records, question, top_n=3):
    """Free, zero-AI-cost keyword retrieval — this is round 1's search, and
    it's also what round 2 re-runs with the model's own keywords/date range.
    """
    q_tokens = _tokenize(question)
    scored = []
    for r in records:
        body = f"{r.get('good_points', '')} {r.get('improve_points', '')} {r.get('next_time_reminder', '')}"
        overlap = len(q_tokens & _tokenize(body))
        if overlap > 0:
            scored.append((overlap, r))
    scored.sort(key=lambda pair: -pair[0])
    return [r for _, r in scored[:top_n]]
