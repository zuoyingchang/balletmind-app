const { splitLines } = require('../lib/text');
const { recordMatchesSearch, searchRecordsByQuestion, foldBalletText, recapFieldIntent, questionTokens } = require('../../public/js/ballet-terms');

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
  const q = String(question || '');
  return /档案|已解决/.test(q) || /我的课记|最近课记/.test(q);
}

function stripAskFillers(q) {
  return String(q || '')
    .replace(/有没有|怎么样|如何|怎样|大吗|练得/g, '')
    .replace(/[吗呢啊呀嘛？?！!。]/g, '')
    .replace(/我的/g, '')
    .replace(/\s+/g, '')
    .trim();
}

function hayMatchesQuestion(hay, question) {
  const q = String(question || '').trim();
  if (!q) return true;
  return searchRecordsByQuestion([{
    class_name: '',
    good_points: hay || '',
    improve_points: '',
    next_time_reminder: '',
    created_at: 1,
  }], q, 1).length > 0;
}

function classIsQuestionTopic(className, question) {
  const n = foldBalletText(className).trim();
  const q = foldBalletText(question).trim();
  return !!(n && q && q.includes(n));
}

function recordHasMatchingLine(record, question) {
  const q = String(question || '').trim();
  if (!q) return false;
  const blobs = [record.good_points, record.improve_points, record.next_time_reminder];
  return blobs.some((t) => splitLines(t).some((line) => hayMatchesQuestion(line, q)));
}

function keepAskLine(line, record, question, hasLineHits, fieldOnly) {
  const q = String(question || '').trim();
  if (!q || wantResolvedSection(q) || fieldOnly) return true;
  if (classIsQuestionTopic(record.class_name, q)) return true;
  if (!hasLineHits) return true;
  return hayMatchesQuestion(line, q);
}

function pushLines(out, text, record, question, hasLineHits, fieldOnly) {
  for (const line of splitLines(text)) {
    if (!keepAskLine(line, record, question, hasLineHits, fieldOnly)) continue;
    out.push({
      text: line,
      cite: citeLabel(record.class_name, record.created_at),
      recordId: record.id,
    });
  }
}

function buildAskDigest({ records, issues, question }) {
  const recs = [...(records || [])].sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  const q = String(question || '').trim();
  const intent = recapFieldIntent(q);
  const fieldOnly = (intent.good !== intent.improve) && (intent.good || intent.improve)
    && questionTokens(q).strong.length === 0;
  const skipGood = intent.improve && !intent.good;
  const skipImprove = intent.good && !intent.improve;
  const good = [];
  const improve = [];
  for (const r of recs) {
    const hasLineHits = recordHasMatchingLine(r, q);
    if (!skipGood) pushLines(good, r.good_points, r, q, hasLineHits, fieldOnly);
    if (!skipImprove) {
      pushLines(improve, [r.improve_points, r.next_time_reminder].filter(Boolean).join('\n'), r, q, hasLineHits, fieldOnly);
    }
  }

  const resolved = [];
  const includeAllResolved = wantResolvedSection(q);
  if (!skipImprove || includeAllResolved) {
  for (const issue of issues || []) {
    if (issue.status !== 'resolved') continue;
    const occ = (issue.occurrences || [])[(issue.occurrences || []).length - 1];
    if (!includeAllResolved && q) {
      const text = String(issue.text || '').trim();
      const className = (occ && occ.className) || '';
      if (!hayMatchesQuestion(text, q) && !classIsQuestionTopic(className, q)
        && !recordMatchesSearch(asSearchRecord(issue, occ), q)) continue;
    }
    resolved.push({
      text: String(issue.text || '').trim(),
      cite: citeLabel(occ && occ.className, occ && occ.createdAt),
      recordId: occ && occ.recordId,
    });
  }
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

function digestFactsText(digest) {
  return (digest.sections || []).map((sec) => {
    const lines = (sec.lines || []).map((line) => {
      const id = Number.isInteger(line.recordId) ? ` [#${line.recordId}]` : '';
      return `- ${line.text}（${line.cite}）${id}`;
    }).join('\n');
    return `## ${sec.title}\n${lines}`;
  }).join('\n\n');
}

module.exports = { buildAskDigest, citeLabel, citeDate, wantResolvedSection, digestFactsText, stripAskFillers };
