// Live Kanban for agent-boss. State comes from /api/state; changes arrive over SSE
// (/api/events). Cards are keyed and patched in place, so motion only happens when a
// task really changes column or phase.
'use strict';

const COLS = [
  ['queued', 'Fila'],
  ['running', 'Executando'],
  ['validating', 'Validando'],
  ['done', 'Concluído'],
  ['blocked', 'Bloqueado'],
];
const PHASE_PT = { starting: 'iniciando', validating: 'validando handoff', active: 'ativa', draining: 'drenando', closed: 'encerrada' };

const $ = (id) => document.getElementById(id);
const board = $('board');
const log = $('log');
const showTools = $('showTools');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (n) => Number(n || 0).toLocaleString('pt-BR');

// --- columns ---
const colEls = {};
for (const [key, label] of COLS) {
  const col = document.createElement('div');
  col.className = 'col';
  col.dataset.col = key;
  col.innerHTML = `<h2>${label}<span class="count">0</span></h2><div class="items"></div>`;
  board.appendChild(col);
  colEls[key] = col;
}

// --- state & rendering ---
let tasks = [];
const seen = new Map(); // id -> { status, phase, html }

function contextBar(t) {
  const live = t.live;
  const sess = t.sessions.at(-1);
  if (!live && !sess) return '';
  const win = live?.ctxWindow || sess?.ctxWindow || 200000;
  const tokens = live?.ctxTokens ?? sess?.ctxTokens ?? 0;
  const budget = live?.budget ?? t.budget ?? win / 2;
  // Scale: the full window, unless the budget is a tiny fraction of it (test budgets).
  const scale = budget * 2 < win ? budget * 2 : win;
  const pct = Math.min(100, (tokens / scale) * 100);
  const cls = tokens >= budget ? 'over' : tokens >= budget * 0.8 ? 'near' : '';
  const scaleLabel = scale === win ? `janela ${fmt(win)}` : `escala 2× orçamento · janela ${fmt(win)}`;
  return `<div class="ctx" title="${fmt(tokens)} tokens ocupados; orçamento ${fmt(budget)}; ${scaleLabel}">
    <div class="bar" role="meter" aria-label="Contexto ocupado" aria-valuemin="0" aria-valuemax="${scale}" aria-valuenow="${tokens}">
      <div class="fill ${cls}" style="width:${pct.toFixed(1)}%"></div>
      <div class="mark" style="left:${((budget / scale) * 100).toFixed(1)}%"></div>
    </div>
    <div class="legend"><span>${fmt(tokens)} tok${live ? '' : ' (última sessão)'}</span><span>orçamento ${fmt(budget)}</span></div>
  </div>`;
}

function lastResult(t) {
  if (t.lastVerify) {
    return `<div class="label">Último resultado verificável</div>
      <div class="val ${t.lastVerify.ok ? 'ok' : 'fail'}" title="${esc(t.lastVerify.command)}">${esc(lastLine(t.lastVerify.output))}</div>`;
  }
  const cp = t.lastCheckpoint?.data;
  if (!cp) return '';
  const v = cp.verified?.at(-1);
  return `<div class="label">Último resultado${v ? ' verificado' : ''}</div><div class="val ${v ? 'ok' : ''}">${esc(v || cp.summary)}</div>`;
}

function cardHtml(t) {
  const live = t.live;
  const cp = t.lastCheckpoint?.data;
  const phase = live?.phase;
  const owner = live ? `${live.sessionId} · pid ${live.pid ?? '–'}` : t.sessions.at(-1)?.id ?? 'sem dono';
  const isParent = t.children.length > 0;
  const kids = isParent ? tasks.filter((k) => k.parentId === t.id) : [];
  const canPause = !t.paused && t.status !== 'done' && t.status !== 'blocked';
  const canResume = t.paused || t.status === 'blocked';
  return `
    <div class="goal" title="${esc(t.goal)}">${esc(t.goal)}</div>
    <div class="meta">
      <span class="pill" title="tarefa">${esc(t.id)}</span>
      <span class="pill" title="dono do lease">epoch ${t.leaseEpoch || '–'}${live ? ' · ' + esc(t.executor) : ''}</span>
      ${phase ? `<span class="pill phase phase-${phase}" title="fase da sessão">${PHASE_PT[phase] ?? phase}${live.drainReason ? ` (${live.drainReason})` : ''}</span>` : ''}
      ${t.paused ? '<span class="pill paused">pausada</span>' : ''}
      ${t.uncertainOps ? `<span class="pill bad">${t.uncertainOps} incerta(s)</span>` : ''}
      ${isParent ? `<span class="pill">${kids.filter((k) => k.status === 'done').length}/${kids.length} partes</span>` : ''}
      ${t.parentId ? `<span class="pill" title="parte de">↳ ${esc(t.parentId)}</span>` : ''}
    </div>
    ${live ? `<div class="muted" title="sessão viva">dono: ${esc(owner)}</div>` : ''}
    ${isParent ? '' : contextBar(t)}
    ${t.status === 'blocked' && t.statusNote ? `<div class="label">Motivo</div><div class="val fail">${esc(t.statusNote)}</div>` : ''}
    ${lastResult(t)}
    ${cp && t.status !== 'done' ? `<div class="label">Próxima ação</div><div class="val">${esc(cp.next_action || '—')}</div>` : ''}
    ${t.live ? peerNote(t.repo, repoPeers()) : ''}
    ${t.sessions.length ? `<div class="epochs" aria-label="sessões">${t.sessions
      .map((s) => `<span class="${s.phase !== 'closed' ? 'live' : /orphan/.test(s.endReason || '') ? 'crash' : s.ackStatus === 'validated' ? 'ack' : ''}" title="sessão ${s.epoch}: ${esc(s.endReason || PHASE_PT[s.phase])}${s.ackStatus !== 'n/a' ? ' · resume_ack ' + s.ackStatus : ''} · ${fmt(s.ctxTokens)} tok"></span>`)
      .join('')}</div>` : ''}
    <div class="actions">
      <button class="btn" data-act="pause" ${canPause ? '' : 'disabled'}>Pausar</button>
      <button class="btn" data-act="resume" ${canResume ? '' : 'disabled'}>Retomar</button>
      <button class="btn" data-act="inspect">Handoff</button>
    </div>`;
}

function render() {
  const counts = Object.fromEntries(COLS.map(([k]) => [k, 0]));
  const alive = new Set();
  // Parents first, their parts right after them.
  const ordered = [];
  for (const t of tasks.filter((x) => !x.parentId)) {
    ordered.push(t);
    ordered.push(...tasks.filter((k) => k.parentId === t.id));
  }
  for (const t of ordered) {
    alive.add(t.id);
    counts[t.status] = (counts[t.status] ?? 0) + 1;
    let el = board.querySelector(`.card[data-id="${CSS.escape(t.id)}"]`);
    const prev = seen.get(t.id);
    const html = cardHtml(t);
    const phase = t.live?.phase ?? null;
    if (!el) {
      el = document.createElement('article');
      el.className = `card${t.parentId ? ' child' : ''}`;
      el.dataset.id = t.id;
    }
    if (!prev || prev.html !== html) el.innerHTML = html;
    const target = colEls[t.status]?.querySelector('.items');
    if (target && el.parentElement !== target) {
      target.appendChild(el);
      if (prev && prev.status !== t.status) restart(el, 'moved'); // real column change
    } else if (target && el.parentElement === target) {
      target.appendChild(el); // keep order stable without animating
    }
    if (prev && prev.phase !== phase && phase) {
      const pill = el.querySelector('.pill.phase');
      if (pill) restart(pill, 'changed'); // real phase change
    }
    seen.set(t.id, { status: t.status, phase, html });
  }
  for (const el of board.querySelectorAll('.card')) if (!alive.has(el.dataset.id)) el.remove();
  for (const [k] of COLS) colEls[k].querySelector('.count').textContent = counts[k];
  const live = tasks.filter((t) => t.live).length;
  $('summary').textContent = `${tasks.length} tarefa(s) · ${live} executor(es) ativo(s)`;
}

function restart(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  el.addEventListener('animationend', () => el.classList.remove(cls), { once: true });
}

const lastLine = (s) => String(s || '').trim().split(/\r?\n/).at(-1) || '';

async function refresh() {
  try {
    const r = await fetch('/api/state', { cache: 'no-store' });
    const st = await r.json();
    tasks = st.tasks;
    external = st.external;
    render();
    renderExternal();
  } catch {}
}

let pending = null;
function scheduleRefresh() {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    refresh();
  }, 120);
}

// --- external sessions (read-only: Claude Code + Codex on this machine) ---
const HARNESS = { 'claude-code': 'Claude Code', codex: 'Codex' };
const TURN_PT = { tool: 'executando ferramenta', thinking: 'pensando', waiting: 'aguardando você', unknown: '—' };
const ACT_PT = { active: 'ativa', stopped: 'parada', idle: 'ociosa' };
let external = null;
const showIdle = $('showIdle');
showIdle.addEventListener('change', () => renderExternal());

const repoKey = (p) => (p ? String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() : null);
const ago = (iso) => {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}min` : `${Math.round(s / 3600)}h`;
};

// Who is working on the same repository right now, across harnesses and the supervisor.
function repoPeers() {
  const peers = new Map();
  const add = (repo, label) => {
    const k = repoKey(repo);
    if (!k) return;
    if (!peers.has(k)) peers.set(k, []);
    peers.get(k).push(label);
  };
  for (const s of external?.sessions ?? []) if (s.activity !== 'idle') add(s.repo, HARNESS[s.harness]);
  for (const t of tasks) if (t.live) add(t.repo, 'agent-boss');
  return peers;
}

function peerNote(repo, peers) {
  const list = peers.get(repoKey(repo)) ?? [];
  if (list.length < 2) return '';
  const counts = list.reduce((o, x) => ((o[x] = (o[x] ?? 0) + 1), o), {});
  const txt = Object.entries(counts).map(([k, n]) => `${k} ×${n}`).join(' · ');
  return `<div class="samerepo" title="${esc(repo)}">⧉ ${list.length} sessões neste repo: ${esc(txt)}</div>`;
}

function xcardHtml(s, peers) {
  const win = s.ctxWindow || 200000;
  const pct = Math.min(100, (s.ctxTokens / win) * 100);
  const half = win / 2;
  const tool = s.lastTool ? `${s.lastTool.name}${s.lastTool.target ? ': ' + s.lastTool.target : ''}` : '';
  const now = s.turn === 'tool' && tool ? `executando ${tool}` : TURN_PT[s.turn];
  const where = [s.cwd, s.gitBranch && s.gitBranch !== 'HEAD' ? `⎇ ${s.gitBranch}` : ''].filter(Boolean).join('  ');
  return `
    <span class="xtag">externa · só leitura</span><span class="htag ${s.harness}">${HARNESS[s.harness]}</span>
    <div class="goal" title="${esc(s.title || s.sessionId)}">${esc(s.title || s.sessionId)}</div>
    <div class="meta">
      <span class="pill"><span class="dot ${s.activity}"></span>${ACT_PT[s.activity]} · ${ago(s.lastActivityAt)}</span>
      ${s.model ? `<span class="pill" title="modelo">${esc(s.model)}</span>` : ''}
      ${s.origin ? `<span class="pill" title="origem">${esc(s.origin)}</span>` : ''}
      ${s.subagents ? `<span class="pill" title="subagentes ativos">${s.subagents} subagente(s)</span>` : ''}
      ${s.rateLimitPct != null ? `<span class="pill ${s.rateLimitPct >= 90 ? 'bad' : s.rateLimitPct >= 70 ? 'warn' : ''}" title="uso da janela de limite da assinatura">limite ${s.rateLimitPct}%</span>` : ''}
    </div>
    <div class="path" title="${esc(where)}">${esc(where || '—')}</div>
    <div class="ctx" title="${fmt(s.ctxTokens)} tokens ocupados de ${fmt(win)}${s.windowEstimated ? ' (janela estimada)' : ''}; marca = 50%">
      <div class="bar" role="meter" aria-label="Contexto ocupado" aria-valuemin="0" aria-valuemax="${win}" aria-valuenow="${s.ctxTokens}">
        <div class="fill ${s.ctxTokens >= half ? 'over' : ''}" style="width:${pct.toFixed(1)}%"></div>
        <div class="mark" style="left:50%"></div>
      </div>
      <div class="legend"><span>${fmt(s.ctxTokens)} tok</span><span>${s.windowEstimated ? '~' : ''}${fmt(win)}</span></div>
    </div>
    <div class="now" title="${esc(tool)}">${esc(now)}</div>
    <div class="muted">${s.prompts} prompt(s) · ${s.toolCalls} ferramenta(s) · ${esc(s.sessionId.slice(0, 8))}</div>
    ${peerNote(s.repo, peers)}`;
}

function renderExternal() {
  const sec = $('external');
  if (!external) {
    sec.hidden = true;
    return;
  }
  sec.hidden = false;
  const all = external.sessions;
  const by = (a) => all.filter((s) => s.activity === a).length;
  const srcs = Object.entries(external.sources).filter(([, on]) => on).map(([k]) => HARNESS[k]).join(' + ') || 'nenhuma fonte';
  $('extCount').textContent = `${by('active')} ativa(s) · ${by('stopped')} parada(s) · ${by('idle')} ociosa(s) · fontes: ${srcs}`;
  const rank = { active: 0, stopped: 1, idle: 2 };
  const visible = all
    .filter((s) => showIdle.checked || s.activity !== 'idle')
    .sort((a, b) => rank[a.activity] - rank[b.activity] || (repoKey(a.repo) ?? '').localeCompare(repoKey(b.repo) ?? '') || b.lastActivityAt.localeCompare(a.lastActivityAt));
  const list = $('extList');
  const peers = repoPeers();
  const alive = new Set();
  for (const s of visible) {
    const id = `${s.harness}:${s.sessionId}`;
    alive.add(id);
    let el = list.querySelector(`.xcard[data-id="${CSS.escape(id)}"]`);
    const isNew = !el;
    if (!el) {
      el = document.createElement('article');
      el.dataset.id = id;
    }
    el.className = `xcard ${s.activity}`;
    const html = xcardHtml(s, peers);
    if (el.dataset.html !== html) {
      el.innerHTML = html;
      el.dataset.html = html;
    }
    list.appendChild(el);
    if (isNew && prevDataIds && !prevDataIds.has(id)) restart(el, 'moved'); // a session that just appeared
  }
  for (const el of list.querySelectorAll('.xcard')) if (!alive.has(el.dataset.id)) el.remove();
  prevDataIds = new Set(all.map((s) => `${s.harness}:${s.sessionId}`));
  let empty = list.querySelector('.ext-empty');
  if (!visible.length) {
    if (!empty) list.insertAdjacentHTML('beforeend', '<div class="ext-empty">Nenhuma sessão externa ativa nas últimas 12 h. Marque "mostrar ociosas" para ver as antigas.</div>');
  } else if (empty) empty.remove();
}
let prevDataIds = null;

// --- actions ---
board.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn || btn.disabled) return;
  const id = btn.closest('.card').dataset.id;
  const act = btn.dataset.act;
  if (act === 'inspect') return inspect(id);
  btn.disabled = true;
  await fetch(`/api/tasks/${encodeURIComponent(id)}/${act}`, { method: 'POST', headers: { 'x-agent-boss': '1' } });
  scheduleRefresh();
});

// --- inspector ---
const dlg = $('inspect');
async function inspect(id) {
  const detail = await fetch(`/api/tasks/${encodeURIComponent(id)}`).then((r) => r.json());
  const t = detail.task;
  $('dlgTitle').textContent = `${t.id} · ${t.goal.slice(0, 90)}`;
  $('dlgSub').textContent = `${detail.sessions.length} sessão(ões) · ${detail.checkpoints.length} checkpoint(s) · epoch atual ${t.leaseEpoch}`;
  const tabs = [{ key: 'next', label: 'Próximo handoff' }];
  for (const s of detail.sessions) if (s.handoffMd) tabs.push({ key: `e${s.epoch}`, label: `Handoff epoch ${s.epoch}`, epoch: s.epoch });
  tabs.push({ key: 'sessions', label: 'Sessões' }, { key: 'ops', label: 'Operações' }, { key: 'constraints', label: 'Restrições' });
  const nav = $('dlgTabs');
  nav.innerHTML = tabs.map((x) => `<button class="btn" role="tab" data-k="${x.key}">${esc(x.label)}</button>`).join('');
  const show = async (key) => {
    for (const b of nav.children) b.setAttribute('aria-selected', String(b.dataset.k === key));
    const tab = tabs.find((x) => x.key === key);
    const body = $('dlgBody');
    if (key === 'next' || tab.epoch) {
      const md = await fetch(`/api/tasks/${encodeURIComponent(id)}/handoff${tab.epoch ? `?epoch=${tab.epoch}` : ''}`).then((r) => r.text());
      body.innerHTML = `<div class="md">${markdown(md)}</div>`;
    } else if (key === 'sessions') {
      body.innerHTML = table(
        ['epoch', 'sessão', 'pid', 'fase', 'contexto', 'resume_ack', 'fim'],
        detail.sessions.map((s) => [s.epoch, s.id, s.pid ?? '', s.phase, `${fmt(s.ctxTokens)} / ${fmt(s.ctxWindow)}`, s.ackStatus, s.endReason ?? '']),
      );
    } else if (key === 'ops') {
      body.innerHTML = table(
        ['epoch', 'ferramenta', 'entrada', 'status', 'incerta em'],
        detail.ops.map((o) => [o.epoch, o.tool, opInput(o.input), o.status, o.uncertainAt ?? '']),
      );
    } else {
      body.innerHTML = table(['id', 'restrição'], t.constraints.map((c) => [c.id, c.text]));
    }
  };
  nav.onclick = (e) => {
    const b = e.target.closest('button[data-k]');
    if (b) show(b.dataset.k);
  };
  await show(tabs.length > 4 ? tabs[tabs.length - 4].key : 'next');
  dlg.showModal();
}

function opInput(raw) {
  try {
    const i = JSON.parse(raw);
    return String(i.file_path ?? i.command ?? i.pattern ?? raw).slice(0, 160);
  } catch {
    return String(raw).slice(0, 160);
  }
}

function table(head, rows) {
  return `<table class="ops"><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`)
    .join('')}</tbody></table>`;
}

// Tiny Markdown renderer for handoffs: headings, bullet lists, fenced code, inline code.
function markdown(md) {
  const out = [];
  let inCode = false;
  let inList = false;
  let prevBlank = true;
  const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');
  for (const line of md.split(/\r?\n/)) {
    if (line.startsWith('```')) {
      if (inList) (out.push('</ul>'), (inList = false));
      out.push(inCode ? '</pre>' : '<pre>');
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(esc(line) + '\n');
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    const li = /^\s*-\s+(.*)$/.exec(line);
    if (li) {
      if (!inList) (out.push('<ul>'), (inList = true));
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    if (inList) (out.push('</ul>'), (inList = false));
    if (h) out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
    else if (line.trim() && out.at(-1)?.endsWith('</p>') && !prevBlank) out[out.length - 1] = out.at(-1).slice(0, -4) + ' ' + inline(line) + '</p>';
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
    prevBlank = !line.trim();
  }
  if (inList) out.push('</ul>');
  if (inCode) out.push('</pre>');
  return out.join('');
}

// --- narration (SSE) ---
const TONE = {
  'handoff.started': 'warn', 'handoff.rejected': 'bad', 'tool.denied': 'warn', 'supervisor.recovered': 'bad',
  'handoff.validated': 'good', 'checkpoint.saved': 'good', 'verify.finished': '', 'constraint.learned': 'warn',
  'task.status': 'strong', 'external.session': 'ext',
};
const pageLoadedAt = Date.now();
function addLog(ev) {
  if (ev.type.startsWith('tool.') && ev.type !== 'tool.denied' && !showTools.checked) return;
  if (ev.type === 'session.context' && !showTools.checked) return;
  const el = document.createElement('li');
  let tone = TONE[ev.type] ?? '';
  if (ev.type === 'verify.finished') tone = ev.data?.ok ? 'good' : 'bad';
  el.className = `ev ${tone}${Date.parse(ev.ts) > pageLoadedAt ? ' fresh' : ''}`;
  const time = new Date(ev.ts).toLocaleTimeString('pt-BR', { hour12: false });
  el.innerHTML = `<time datetime="${esc(ev.ts)}">${time}</time>${ev.taskId ? `<span class="tid">${esc(ev.taskId)}</span>` : ''}${esc(ev.narration)}`;
  log.prepend(el);
  while (log.childElementCount > 400) log.lastChild.remove();
}

const conn = $('conn');
const es = new EventSource('/api/events');
es.onopen = () => {
  conn.className = 'on';
  conn.textContent = 'ao vivo';
  refresh();
};
es.onerror = () => {
  conn.className = 'off';
  conn.textContent = 'reconectando';
};
es.onmessage = (m) => {
  const ev = JSON.parse(m.data);
  addLog(ev);
  scheduleRefresh();
  // Same stream the future Chrome narration extension listens to.
  window.dispatchEvent(new CustomEvent('supervisor-event', { detail: ev }));
};
refresh();
// External sessions don't emit an event for every token; poll them gently.
setInterval(() => !document.hidden && scheduleRefresh(), 4000);

// --- server controls (stop / restart the supervisor process itself) ---
const banner = $('banner');
const btnRestart = $('btnRestart');
const btnStop = $('btnStop');
let health = null;

function showBanner(html, bad = false) {
  banner.innerHTML = html;
  banner.className = `banner${bad ? ' bad' : ''}`;
  banner.hidden = !html;
}

async function loadHealth() {
  try {
    health = await fetch('/api/health', { cache: 'no-store' }).then((r) => r.json());
    $('srvInfo').textContent = `pid ${health.pid}${health.daemonPid ? ' · daemon' : ''}`;
    btnRestart.disabled = !health.daemonPid;
    btnRestart.title = health.daemonPid
      ? 'Encerra e sobe o servidor de novo; tarefas em execução voltam à fila e retomam com handoff.'
      : 'Reinício pelo board precisa do daemon: abra o agent-boss pelo "Agent Boss.cmd".';
    btnStop.disabled = false;
    return health;
  } catch {
    return null;
  }
}

async function adminAction(action) {
  await loadHealth();
  const live = health?.liveExecutors ?? 0;
  const what = action === 'restart' ? 'Reiniciar o servidor' : 'Parar o servidor';
  const extra = live
    ? `\n\n${live} executor(es) em execução serão encerrados. As operações em andamento ficam marcadas como incertas e as tarefas ${action === 'restart' ? 'retomam com handoff logo após o reinício' : 'retomam quando o servidor subir de novo'}.`
    : '';
  if (!confirm(`${what}?${extra}`)) return;
  btnRestart.disabled = btnStop.disabled = true;
  const before = health?.startedAt;
  const r = await fetch(`/api/admin/${action}`, { method: 'POST', headers: { 'x-agent-boss': '1' } }).catch(() => null);
  if (!r || !r.ok) {
    showBanner(`Não foi possível ${action === 'restart' ? 'reiniciar' : 'parar'}: ${r ? (await r.json()).error : 'servidor inacessível'}`, true);
    loadHealth();
    return;
  }
  if (action === 'stop') {
    showBanner('Servidor parado. Para iniciar de novo, dê dois cliques em <code>Agent Boss.cmd</code> na pasta do agent-boss.', true);
    return;
  }
  showBanner('Reiniciando o servidor…');
  for (let i = 0; i < 60; i++) {
    await new Promise((res) => setTimeout(res, 500));
    const h = await fetch('/api/health', { cache: 'no-store' }).then((x) => x.json()).catch(() => null);
    if (h && h.startedAt !== before) {
      showBanner('');
      await loadHealth();
      refresh();
      return;
    }
  }
  showBanner('O servidor não voltou em 30 s. Veja <code>data/agent-boss.log</code> ou abra pelo <code>Agent Boss.cmd</code>.', true);
}

// Hosted board link. Connecting navigates this tab to the hosted /connect page (sign in, confirm);
// it redirects back to /cloud/callback, which lands here with ?cloud=connected or ?cloud=error.
const btnCloud = $('btnCloud');
let cloud = null;

async function loadCloud() {
  cloud = await fetch('/api/cloud', { cache: 'no-store' }).then((r) => r.json()).catch(() => null);
  if (!cloud) return;
  btnCloud.textContent = cloud.connected ? `Online: ${cloud.email ?? cloud.machine}` : 'Conectar ao board online';
  btnCloud.classList.toggle('ok', cloud.connected && !cloud.lastError);
  btnCloud.title = cloud.connected
    ? `Conectado a ${cloud.url}${cloud.lastError ? `\nÚltimo erro: ${cloud.lastError}` : ''}\nClique para desconectar esta máquina.`
    : `Abre ${cloud.url} para entrar com sua conta e autorizar esta máquina.`;
}

btnCloud.addEventListener('click', async () => {
  await loadCloud();
  if (cloud?.connected) {
    if (!confirm(`Desconectar esta máquina do board online (${cloud.url})?\n\nO board online deixa de ver e de controlar este agent-boss.`)) return;
    await fetch('/api/cloud/disconnect', { method: 'POST', headers: { 'x-agent-boss': '1' } });
    showBanner('Máquina desconectada do board online.');
    return loadCloud();
  }
  const r = await fetch('/api/cloud/connect', { method: 'POST', headers: { 'x-agent-boss': '1' } }).then((x) => x.json()).catch(() => null);
  if (r?.url) location.href = r.url;
  else showBanner('Não foi possível iniciar a conexão com o board online.', true);
});

{
  const q = new URLSearchParams(location.search);
  if (q.get('cloud') === 'connected') showBanner('Conectado ao board online. Esta máquina já aparece lá.');
  if (q.get('cloud') === 'error') showBanner(`Conexão com o board online falhou: ${esc(q.get('reason') ?? 'erro desconhecido')}`, true);
  if (q.has('cloud')) history.replaceState(null, '', '/');
}
loadCloud();
setInterval(loadCloud, 15_000);

btnRestart.addEventListener('click', () => adminAction('restart'));
btnStop.addEventListener('click', () => adminAction('stop'));
es.addEventListener('open', loadHealth);
loadHealth();
