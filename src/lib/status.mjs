// Parser for the statusline stdin JSON (Claude Code v2.1.x). Every field is
// optional at runtime (pre-first-API-call, non-subscriber, unnamed session,
// post-/compact) — parsing must never throw and absent data stays null so the
// renderer can omit it instead of inventing values.

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v) {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function emptyStatus() {
  return {
    ok: false,
    sessionId: null,
    sessionName: null,
    transcriptPath: null,
    cwd: null,
    projectDir: null,
    promptId: null,
    model: { id: null, name: null },
    effort: null,
    fastMode: false,
    thinking: false,
    repo: null,
    gitWorktree: null,
    pr: null,
    agentName: null,
    remoteSessionId: null,
    vimMode: null,
    cost: null,
    context: null,
    rateLimits: { fiveHour: null, sevenDay: null },
    exceeds200k: false,
    version: null,
    outputStyle: null,
    raw: null,
  };
}

function parseWindow(w) {
  if (!w || typeof w !== 'object') return null;
  const usage = w.current_usage && typeof w.current_usage === 'object' ? w.current_usage : null;
  return {
    usedPct: num(w.used_percentage),
    remainingPct: num(w.remaining_percentage),
    size: num(w.context_window_size),
    totalIn: num(w.total_input_tokens),
    totalOut: num(w.total_output_tokens),
    usage: usage
      ? {
          input: num(usage.input_tokens),
          output: num(usage.output_tokens),
          cacheCreate: num(usage.cache_creation_input_tokens),
          cacheRead: num(usage.cache_read_input_tokens),
        }
      : null,
  };
}

function parseLimit(l) {
  if (!l || typeof l !== 'object' || num(l.used_percentage) === null) return null;
  return { pct: num(l.used_percentage), resetsAt: num(l.resets_at) };
}

export function parseStatus(input) {
  const s = emptyStatus();
  let j;
  try {
    j = JSON.parse(String(input ?? ''));
  } catch {
    return s;
  }
  if (!j || typeof j !== 'object') return s;

  const ws = j.workspace && typeof j.workspace === 'object' ? j.workspace : {};
  s.ok = true;
  s.sessionId = str(j.session_id);
  s.sessionName = str(j.session_name);
  s.transcriptPath = str(j.transcript_path);
  s.cwd = str(ws.current_dir) ?? str(j.cwd);
  s.projectDir = str(ws.project_dir);
  s.promptId = str(j.prompt_id);
  s.model = {
    id: str(j.model?.id),
    name: str(j.model?.display_name),
  };
  s.effort = str(j.effort?.level);
  s.fastMode = j.fast_mode === true;
  s.thinking = j.thinking?.enabled === true;
  s.repo =
    ws.repo && typeof ws.repo === 'object'
      ? { host: str(ws.repo.host), owner: str(ws.repo.owner), name: str(ws.repo.name) }
      : null;
  s.gitWorktree = str(ws.git_worktree);
  s.pr =
    j.pr && typeof j.pr === 'object' && num(j.pr.number) !== null
      ? { number: num(j.pr.number), url: str(j.pr.url), reviewState: str(j.pr.review_state) }
      : null;
  s.agentName = str(j.agent?.name);
  s.remoteSessionId = str(j.remote?.session_id);
  s.vimMode = str(j.vim?.mode);
  s.cost =
    j.cost && typeof j.cost === 'object'
      ? {
          usd: num(j.cost.total_cost_usd),
          durationMs: num(j.cost.total_duration_ms),
          apiMs: num(j.cost.total_api_duration_ms),
          linesAdded: num(j.cost.total_lines_added),
          linesRemoved: num(j.cost.total_lines_removed),
        }
      : null;
  s.context = parseWindow(j.context_window);
  s.rateLimits = {
    fiveHour: parseLimit(j.rate_limits?.five_hour),
    sevenDay: parseLimit(j.rate_limits?.seven_day),
  };
  s.exceeds200k = j.exceeds_200k_tokens === true;
  s.version = str(j.version);
  s.outputStyle = str(j.output_style?.name);
  s.raw = j;
  return s;
}
