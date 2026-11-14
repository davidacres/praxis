import { materialize } from './format.mjs';

// A deterministic transport: time is supplied by the caller, never by model execution.
export class TimelinePlayer {
  constructor(rows, deliver, schedule = setTimeout, cancel = clearTimeout) {
    this.rows = rows; this.deliver = deliver; this.schedule = schedule; this.cancel = cancel;
    this.index = -1; this.speed = 1; this.playing = false; this.generation = 0;
  }
  pause() { this.playing = false; this.generation++; this.cancel(this.timer); }
  async step() {
    if (this.index + 1 >= this.rows.length) { this.pause(); return; }
    const row = this.rows[++this.index];
    this.current = materialize(this.current, row.payload);
    await this.deliver(row, this.current);
  }
  async restart() { this.pause(); await this.inFlight; this.index = -1; this.current = undefined; await this.step(); }
  play() {
    if (this.playing || this.index + 1 >= this.rows.length) return;
    this.playing = true;
    const generation = ++this.generation;
    const next = () => {
      if (!this.playing || generation !== this.generation) return;
      if (this.index + 1 >= this.rows.length) { this.pause(); return; }
      const delay = Math.max(0, this.rows[this.index + 1].at - (this.rows[this.index]?.at || 0)) / this.speed;
      this.timer = this.schedule(async () => {
        if (generation !== this.generation) return;
        try { this.inFlight = this.step(); await this.inFlight; next(); } catch (error) { this.pause(); this.error = error; }
      }, delay);
    };
    next();
  }
}

export function modelEvidence(processes, requested) {
  const accepted = []; const reported = new Set();
  for (const process of processes) {
    const requests = new Map();
    for (const { direction, message } of process.frames) {
      if (direction === 'to-agent' && message.method && message.id !== undefined) requests.set(message.id, message);
      if (direction !== 'from-agent') continue;
      const req = requests.get(message.id);
      if (req?.method === 'session/set_config_option' && req.params.configId === 'model') {
        const selected = message.result?.configOptions?.find(option => option.id === 'model' || option.category === 'model')?.currentValue;
        accepted.push({ requested: req.params.value, accepted: !message.error && (!selected || selected === req.params.value), selected, error: message.error });
      }
      const usage = message.result?._meta?.quota?.model_usage;
      for (const row of Array.isArray(usage) ? usage : []) if (row.model) reported.add(row.model);
    }
  }
  return { requested, selections: accepted, accepted: accepted.length > 0 && accepted.every(row => row.requested === requested && row.accepted), reported: [...reported] };
}

// Simulate requests from the agent rather than asking the host to execute recorded tools.
export function replaySegments(frames) {
  const simulated = new Set(frames.filter(row => row.direction === 'from-agent' && row.message.method && row.message.id !== undefined).map(row => row.message.id));
  const rows = frames.filter(row => !(
    row.direction === 'from-agent' && row.message.method && row.message.id !== undefined
  ) && !(row.direction === 'to-agent' && !row.message.method && simulated.has(row.message.id)));
  const segments = [];
  for (const row of rows) {
    if (row.direction === 'to-agent') segments.push({ request: row.message, at: row.at, replies: [], replyTimes: [] });
    else if (segments.length) { segments.at(-1).replies.push(row.message); segments.at(-1).replyTimes.push(row.at); }
  }
  return segments;
}

export function matchesRequest(recorded, actual, prompts) {
  if (recorded.method !== actual.method) return false;
  if (!recorded.method) return false;
  if (recorded.method === 'session/prompt') {
    const a = JSON.stringify(actual.params?.prompt);
    const r = JSON.stringify(recorded.params?.prompt);
    const expected = prompts.filter(prompt => r.includes(JSON.stringify(prompt).slice(1,-1))).at(-1);
    return Boolean(expected && a.includes(JSON.stringify(expected).slice(1,-1)));
  }
  const canonical = value => {
    if (Array.isArray(value)) return value.map(canonical);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).filter(([key]) => !['sessionId','cwd','mcpServers','clientInfo','clientCapabilities'].includes(key)).sort(([a],[b])=>a.localeCompare(b)).map(([k,v]) => [k,canonical(v)]));
  };
  return JSON.stringify(canonical(recorded.params)) === JSON.stringify(canonical(actual.params));
}

// Expectations come from the captured wire after the prompt gate, not old host snapshots.
// Those snapshots intentionally remain useful for compatibility replay.
export function recordedReplies(bundle) {
  return bundle.processes.flatMap(process => {
    const start = process.frames.findIndex(frame => frame.direction === 'to-agent' && frame.message.method === 'session/prompt');
    if (start < 0) return [];
    const parts=[];
    for (const frame of process.frames.slice(start+1)) {
      const update=frame.message.params?.update;
      if (frame.direction !== 'from-agent' || update?.sessionUpdate !== 'agent_message_chunk' || update.content?.type !== 'text') continue;
      if (update._meta?.jetbrains?.air?.phase === 'commentary') continue;
      const id=update.messageId ?? null;
      if (parts.at(-1)?.id === id) parts.at(-1).text += update.content.text;
      else parts.push({id,text:update.content.text});
    }
    const prompt=JSON.stringify(process.frames[start].message.params.prompt);
    const turn=bundle.scenario.prompts.findIndex(text=>prompt.includes(JSON.stringify(text).slice(1,-1)));
    return [{turn,text:parts.map(part=>part.text).join('\n\n')}];
  }).sort((a,b)=>a.turn-b.turn).map(row=>row.text);
}
