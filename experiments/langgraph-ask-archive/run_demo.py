"""Run this after setting ANTHROPIC_API_KEY, e.g.:

    export ANTHROPIC_API_KEY=sk-ant-...
    source venv/bin/activate
    python run_demo.py

Try a simple question first (should cost exactly 1 model call, round=1),
then a comparison question spanning both mock months (should cost 2).
"""
from ask_archive_graph import ask

if __name__ == "__main__":
    for q in [
        "我转圈的时候有什么问题？",
        "这个月和上个月比，转圈的问题有变化吗？",
    ]:
        print("=" * 60)
        print("问题：", q)
        result = ask(q)
        print("rounds:", result["rounds"])
        print("answered:", result["answered"])
        print("answer:", result["answer"])
        print("cited_ids:", result["cited_ids"])
