// Agent run metrics dashboard (docs/pipeline.md, Run metrics). Static, no build step; served from the gh-pages root.
// The records are public data written by the pipeline: every value is re-checked here (numbers, enum strings) and
// reaches the page only through textContent, attributes or the canvas — never innerHTML.
(() => {
  'use strict';

  const STAGES = ['refine', 'develop', 'review', 'hwtest', 'uat', 'screen', 'other'];
  const COLORS = {
    refine: '#8250df',
    develop: '#0969da',
    review: '#1a7f37',
    hwtest: '#bf8700',
    uat: '#cf222e',
    screen: '#57606a',
    other: '#9a6700',
  };
  const NAME = /^[0-9]{1,15}-[0-9]{1,6}\.json$/;
  const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
  const $ = (id) => document.getElementById(id);
  const charts = {};
  let records = [];

  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  const int = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
  const tok = (v) => (typeof v === 'string' && TOKEN.test(v) ? v : null);
  const oneOf = (v, list) => (list.includes(v) ? v : null);

  function stage(s) {
    if (!s || typeof s !== 'object') return null;
    return {
      stage: oneOf(s.stage, STAGES) || 'other',
      model: tok(s.model) || 'unknown',
      cli: tok(s.cli_version) || 'unknown',
      turns: num(s.num_turns),
      minutes: num(s.duration_ms) / 60000,
      cost: num(s.cost_usd),
      tokens: num(s.input_tokens) + num(s.output_tokens) + num(s.cache_read_tokens) + num(s.cache_creation_tokens),
    };
  }

  function record(r) {
    if (!r || typeof r !== 'object' || r.schema !== 1 || !['run', 'uat'].includes(r.type)) return null;
    const ctx = r.context && typeof r.context === 'object' ? r.context : {};
    const stages = Array.isArray(r.stages) ? r.stages.map(stage).filter(Boolean) : [];
    return {
      type: r.type,
      ts: num(r.timestamp) * 1000,
      issue: int(r.issue),
      round: int(r.round) || 1,
      kind: oneOf(r.kind, ['issue', 'uat']) || (r.type === 'uat' ? 'uat' : null),
      risk: oneOf(r.risk, ['low', 'medium', 'high']),
      size: oneOf(r.size, ['S', 'M', 'L', 'XL']),
      commit: typeof r.prompt_commit === 'string' && /^[0-9a-f]{12}$/.test(r.prompt_commit) ? r.prompt_commit : null,
      context: {
        total: num(ctx.total),
        claude_md: num(ctx.claude_md),
        agents: num(ctx.agents),
        prompts: num(ctx.prompts),
        skills: num(ctx.skills),
        docs: num(ctx.docs),
      },
      stages,
      gate: typeof r.gate === 'boolean' ? r.gate : null,
      findings: ['review_blockers', 'review_majors', 'review_minors'].map((k) => int(r[k])),
      hwtest: oneOf(r.hwtest, ['pass', 'fail', 'blocked']),
      status: tok(r.status) || 'unknown',
      verdict: oneOf(r.verdict, ['ACCEPTED', 'REJECTED']),
      rejected: int(r.rejected),
    };
  }

  async function getJSON(path) {
    const res = await fetch(path, { cache: 'no-cache', credentials: 'omit' });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
  }

  async function load() {
    const index = await getJSON('data/index.json');
    const names = Array.isArray(index && index.runs)
      ? index.runs.filter((n) => typeof n === 'string' && NAME.test(n))
      : [];
    const out = [];
    for (let i = 0; i < names.length; i += 20) {
      const batch = await Promise.all(names.slice(i, i + 20).map((n) => getJSON(`data/runs/${n}`).catch(() => null)));
      out.push(...batch.map(record).filter(Boolean));
    }
    return out.sort((a, b) => a.ts - b.ts);
  }

  const day = (ts) => new Date(ts).toISOString().slice(0, 10);
  const fmt = (n, d = 0) => n.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });

  function options(select, values) {
    select.replaceChildren();
    for (const v of ['all', ...values]) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = v;
      select.append(o);
    }
  }

  function filters() {
    const runs = records.filter((r) => r.type === 'run');
    const uniq = (f) => [...new Set(runs.flatMap(f))].sort();
    options(
      $('f-model'),
      uniq((r) => r.stages.map((s) => s.model)),
    );
    options(
      $('f-cli'),
      uniq((r) => r.stages.map((s) => s.cli)),
    );
    options($('f-size'), ['S', 'M', 'L', 'XL']);
    options($('f-risk'), ['low', 'medium', 'high']);
    for (const id of ['f-model', 'f-cli', 'f-size', 'f-risk', 'f-from', 'f-to'])
      $(id).addEventListener('change', render);
  }

  function selected() {
    const v = (id) => $(id).value;
    const from = v('f-from') ? Date.parse(v('f-from')) : -Infinity;
    const to = v('f-to') ? Date.parse(v('f-to')) + 86400000 : Infinity;
    return records.filter(
      (r) =>
        r.ts >= from &&
        r.ts < to &&
        (v('f-model') === 'all' || r.stages.some((s) => s.model === v('f-model'))) &&
        (v('f-cli') === 'all' || r.stages.some((s) => s.cli === v('f-cli'))) &&
        (v('f-size') === 'all' || r.size === v('f-size')) &&
        (v('f-risk') === 'all' || r.risk === v('f-risk')),
    );
  }

  // Indices where the set of models, the CLI versions or the prompt commit differ from the previous record.
  function changes(list) {
    const marks = [];
    const key = (r, f) => [...new Set(r.stages.map(f))].sort().join(',');
    for (let i = 1; i < list.length; i++) {
      const what = [];
      const [a, b] = [list[i - 1], list[i]];
      if (b.stages.length && a.stages.length && key(a, (s) => s.model) !== key(b, (s) => s.model)) what.push('model');
      if (b.stages.length && a.stages.length && key(a, (s) => s.cli) !== key(b, (s) => s.cli)) what.push('cli');
      if (a.commit && b.commit && a.commit !== b.commit) what.push('prompt');
      if (what.length) marks.push({ i, label: what.join('+') });
    }
    return marks;
  }

  const markers = {
    id: 'markers',
    afterDatasetsDraw(chart, _args, opts) {
      const marks = opts && Array.isArray(opts.marks) ? opts.marks : [];
      const x = chart.scales.x;
      const { top, bottom } = chart.chartArea;
      const ctx = chart.ctx;
      ctx.save();
      ctx.strokeStyle = getComputedStyle(document.body).color;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.globalAlpha = 0.6;
      ctx.setLineDash([4, 4]);
      ctx.font = '10px system-ui, sans-serif';
      for (const m of marks) {
        const px = (x.getPixelForValue(m.i - 1) + x.getPixelForValue(m.i)) / 2;
        ctx.beginPath();
        ctx.moveTo(px, top);
        ctx.lineTo(px, bottom);
        ctx.stroke();
        ctx.fillText(m.label, px + 3, top + 10);
      }
      ctx.restore();
    },
  };

  function draw(id, type, labels, datasets, marks, stacked) {
    if (charts[id]) charts[id].destroy();
    charts[id] = new window.Chart($(id), {
      type,
      data: { labels, datasets },
      plugins: [markers],
      options: {
        animation: false,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales: { x: { stacked, ticks: { maxRotation: 60, autoSkip: true } }, y: { stacked, beginAtZero: true } },
        plugins: { markers: { marks }, legend: { position: 'bottom' } },
      },
    });
  }

  function charts4(runs) {
    const labels = runs.map((r) => `#${r.issue ?? '?'} r${r.round} ${day(r.ts)}`);
    const marks = changes(runs);
    const present = STAGES.filter((s) => runs.some((r) => r.stages.some((x) => x.stage === s)));
    const sets = (f) =>
      present.map((s) => ({
        label: s,
        backgroundColor: COLORS[s],
        data: runs.map((r) => r.stages.filter((x) => x.stage === s).reduce((t, x) => t + f(x), 0)),
      }));
    draw(
      'c-tokens',
      'bar',
      labels,
      sets((x) => x.tokens),
      marks,
      true,
    );
    draw(
      'c-turns',
      'bar',
      labels,
      sets((x) => x.turns),
      marks,
      true,
    );
    draw(
      'c-duration',
      'bar',
      labels,
      sets((x) => x.minutes),
      marks,
      true,
    );
    draw(
      'c-cost',
      'bar',
      labels,
      sets((x) => x.cost),
      marks,
      true,
    );
  }

  function contextChart(list) {
    const parts = ['total', 'docs', 'agents', 'prompts', 'claude_md', 'skills'];
    const palette = ['#0969da', '#1a7f37', '#8250df', '#bf8700', '#cf222e', '#57606a'];
    const datasets = parts.map((p, i) => ({
      label: p,
      borderColor: palette[i],
      backgroundColor: palette[i],
      pointRadius: 2,
      data: list.map((r) => Math.round(r.context[p] / 4)),
    }));
    draw(
      'c-context',
      'line',
      list.map((r) => day(r.ts)),
      datasets,
      changes(list).filter((m) => m.label.includes('prompt')),
      false,
    );
  }

  function issueLink(n) {
    // https://<owner>.github.io/<repo>/ → https://github.com/<owner>/<repo>/issues/<n>
    const owner = location.hostname.match(/^([A-Za-z0-9-]{1,39})\.github\.io$/);
    const repo = location.pathname.match(/^\/([A-Za-z0-9._-]{1,100})\//);
    if (!owner || !repo || n === null) return document.createTextNode(n === null ? '?' : `#${n}`);
    const a = document.createElement('a');
    a.setAttribute('href', `https://github.com/${owner[1]}/${repo[1]}/issues/${n}`);
    a.setAttribute('rel', 'noopener noreferrer');
    a.textContent = `#${n}`;
    return a;
  }

  function table(list) {
    const by = new Map();
    for (const r of list) {
      const k = r.issue === null ? '?' : r.issue;
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(r);
    }
    const body = $('issues').querySelector('tbody');
    body.replaceChildren();
    const rows = [...by.entries()].sort((a, b) => b[1][b[1].length - 1].ts - a[1][a[1].length - 1].ts);
    for (const [issue, recs] of rows) {
      const runs = recs.filter((r) => r.type === 'run');
      const uats = recs.filter((r) => r.type === 'uat');
      const first = runs.find((r) => r.round === 1 && r.gate !== null);
      const sum = (i) => runs.reduce((t, r) => t + (r.findings[i] || 0), 0);
      const hw = [...runs].reverse().find((r) => r.hwtest);
      const uat = [...uats].reverse().find((r) => r.verdict);
      const all = recs.flatMap((r) => r.stages);
      const cells = [
        null,
        (runs[0] && runs[0].kind) || (uats.length ? 'uat' : '?'),
        String(runs.length),
        String(runs.length ? Math.max(...runs.map((r) => r.round)) - 1 : 0),
        first ? (first.gate ? 'green' : 'red') : '–',
        runs.some((r) => r.findings.some((f) => f !== null)) ? `${sum(0)}/${sum(1)}/${sum(2)}` : '–',
        hw ? hw.hwtest : '–',
        uat ? `${uat.verdict}${uat.rejected ? ` (${uat.rejected} rejected)` : ''}` : '–',
        fmt(all.reduce((t, s) => t + s.tokens, 0)),
        fmt(
          all.reduce((t, s) => t + s.cost, 0),
          2,
        ),
        recs[recs.length - 1].status,
      ];
      const tr = document.createElement('tr');
      cells.forEach((c, i) => {
        const td = document.createElement('td');
        if (i === 0) td.append(issueLink(issue === '?' ? null : issue));
        else td.textContent = c;
        tr.append(td);
      });
      body.append(tr);
    }
  }

  function render() {
    const list = selected();
    const runs = list.filter((r) => r.type === 'run');
    $('count').textContent = `${runs.length} runs, ${list.length - runs.length} UAT verdicts`;
    charts4(runs);
    contextChart(list);
    table(list);
  }

  async function main() {
    if (!window.Chart) {
      $('status').textContent = 'Chart.js did not load.';
      return;
    }
    const style = getComputedStyle(document.body);
    window.Chart.defaults.color = style.color;
    window.Chart.defaults.borderColor = style.getPropertyValue('--line').trim() || '#d1d9e0';
    try {
      records = await load();
    } catch (e) {
      $('status').textContent = `No data yet (${e instanceof Error ? e.message : 'load failed'}).`;
      return;
    }
    $('status').textContent = records.length ? '' : 'No records yet.';
    filters();
    render();
  }

  main();
})();
