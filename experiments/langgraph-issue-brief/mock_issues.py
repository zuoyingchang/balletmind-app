"""Mock recurring-issue data, shaped exactly like the real
listIssuesWithOccurrences() output in server/issues.js — same fields
(text, status, occurrence_count, occurrences[{recordId, createdAt,
className}]) so the pipeline below is consuming real production output
shape, not an invented schema.

Deliberately includes two issues that are textually different but
conceptually the same theme (骨盆晃 vs 重心不稳 vs 核心力量不够) — the
real matcher in issues.js only does containment matching ("na.includes(nb)"),
so it would never merge these. That gap is exactly what the 分析 Agent
below is for.
"""
from datetime import datetime, timezone


def _day_ms(y, m, d):
    return int(datetime(y, m, d, tzinfo=timezone.utc).timestamp() * 1000)


MOCK_ISSUES = [
    {
        "id": 1,
        "text": "转圈的时候重心不稳，骨盆晃",
        "status": "open",
        "occurrence_count": 4,
        "occurrences": [
            {"recordId": 10, "createdAt": _day_ms(2026, 8, 4), "className": "芭蕾基础课"},
            {"recordId": 14, "createdAt": _day_ms(2026, 8, 18), "className": "芭蕾基础课"},
            {"recordId": 21, "createdAt": _day_ms(2026, 9, 5), "className": "芭蕾进阶课"},
            {"recordId": 27, "createdAt": _day_ms(2026, 9, 13), "className": "芭蕾进阶课"},
        ],
    },
    {
        "id": 2,
        "text": "核心力量不够，转圈容易垮",
        "status": "open",
        "occurrence_count": 2,
        "occurrences": [
            {"recordId": 21, "createdAt": _day_ms(2026, 9, 5), "className": "芭蕾进阶课"},
            {"recordId": 27, "createdAt": _day_ms(2026, 9, 13), "className": "芭蕾进阶课"},
        ],
    },
    {
        "id": 3,
        "text": "arabesque后腿高度不够",
        "status": "open",
        "occurrence_count": 2,
        "occurrences": [
            {"recordId": 12, "createdAt": _day_ms(2026, 8, 11), "className": "芭蕾基础课"},
            {"recordId": 24, "createdAt": _day_ms(2026, 9, 8), "className": "芭蕾进阶课"},
        ],
    },
    {
        "id": 4,
        "text": "落地声音有点重",
        "status": "open",
        "occurrence_count": 1,
        "occurrences": [
            {"recordId": 27, "createdAt": _day_ms(2026, 9, 13), "className": "芭蕾进阶课"},
        ],
    },
]
