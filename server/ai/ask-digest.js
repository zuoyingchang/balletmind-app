const { splitLines } = require('../lib/text');
const { recordMatchesSearch } = require('../../public/js/ballet-terms');

function citeDate(ts) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function citeClass(name) {
  const n = String(name || '').trim();
  if (!n || n === '训练记录' || /^\d{1,2}月\d{1,2}日训练$/.test(n)) return '';
  return n;
}

function citeLabel(className, ts) {
  const c = citeClass(className);
  const d = citeDate(ts);
  return c ? `${c} ${d}` : d;
}

function asSearchRecord(issue, occ) {
  return {
    class_name: (occ && occ.className) || '',
    good_points: '',
    improve_points: issue.text || '',
    next_time_reminder: '',
    transcript: '',
  };
}

function wantResolvedSection(question) {
  return /档案|课记|已解决/.test(String(question || ''));
}

function pushLines(out, text, record) {
  for (const line of splitLines(text)) {
    out.push({
      text: line,
      cite: citeLabel(record.class_name, record.created_at),
      recordId: record.id,
    });
  }
}

function buildAskDigest({ records, issues, question }) {
  const recs = [...(records || [])].sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  const good = [];
  const improve = [];
  for (const r of recs) {
    pushLines(good, r.good_points, r);
    pushLines(improve, [r.improve_points, r.next_time_reminder].filter(Boolean).join('\n'), r);
  }

  const q = String(question || '').trim();
  const resolved = [];
  const includeAllResolved = wantResolvedSection(q);
  for (const issue of issues || []) {
    if (issue.status !== 'resolved') continue;
    const occ = (issue.occurrences || [])[(issue.occurrences || []).length - 1];
    if (!includeAllResolved && q && !recordMatchesSearch(asSearchRecord(issue, occ), q)) continue;
    resolved.push({
      text: String(issue.text || '').trim(),
      cite: citeLabel(occ && occ.className, occ && occ.createdAt),
      recordId: occ && occ.recordId,
    });
  }

  const sections = [];
  if (good.length) sections.push({ id: 'good', title: '做得好的', lines: good });
  if (improve.length) sections.push({ id: 'improve', title: '待改进', lines: improve });
  if (resolved.length) sections.push({ id: 'resolved', title: '已解决', lines: resolved });

  const answered = sections.length > 0;
  const answerPoints = answered
    ? sections.flatMap((sec) => [sec.title, ...sec.lines.map((line) => `${line.text}（${line.cite}）`)])
    : ['档案里还没有找到相关记录。'];
  const citedRecordIds = [...new Set(sections.flatMap((sec) => sec.lines.map((line) => line.recordId).filter(Boolean)))];

  return { answered, sections, answerPoints, citedRecordIds };
}

module.exports = { buildAskDigest, citeLabel, citeDate, wantResolvedSection };
