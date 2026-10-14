#!/usr/bin/env node
// Video generation through a running H3 Studio (ComfyUI workflows on Modal or another
// ComfyUI). Node 18+, no dependencies.
//
//   node video.mjs status
//   node video.mjs workflows [--all]
//   node video.mjs presets
//   node video.mjs params (--workflow W | --card C)
//   node video.mjs run (--workflow W | --card C) [--image F] (--prompt T | --prompt-file F)
//                      [--seeds 1,2 | --count N [--seed-start S]] [--duration SEC] [--mp X]
//                      [--set id=value]... [--on switch]... [--off switch]...
//                      [--project P] [--name N] --out DIR [--dry-run] [--wait] [--timeout-min M]
//   node video.mjs wait <DIR | run.json> [--timeout-min M] [--interval SEC]
//   node video.mjs cancel <DIR | run.json>
//
// H3_STUDIO_URL: where Studio listens (default http://127.0.0.1:53290).
// Exit codes: 0 ok, 1 bad request or error, 2 Studio not reachable,
//             4 some videos failed, 5 still running when --timeout-min ran out.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const STUDIO = (process.env.H3_STUDIO_URL ?? 'http://127.0.0.1:53290').replace(/\/+$/, '');
const RUN_PREFIX = 'video_run_';
const FINAL = ['done', 'failed', 'canceled', 'missing'];

class Exit extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// --- arguments ------------------------------------------------------------------

const REPEATABLE = new Set(['set', 'on', 'off']);
const FLAGS = new Set(['all', 'dry-run', 'wait', 'json']);

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      opts._.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (FLAGS.has(name)) {
      opts[name] = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) throw new Exit(1, `--${name} 缺少取值`);
    if (REPEATABLE.has(name)) (opts[name] ??= []).push(value);
    else opts[name] = value;
  }
  return opts;
}

/** "0.5" -> 0.5, "true" -> true, anything that is not JSON stays a string. */
function parseValue(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function projectName() {
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (top) return path.basename(top);
  } catch {
    // not a git checkout
  }
  return path.basename(process.cwd());
}

// --- Studio API -----------------------------------------------------------------

async function api(route, { method = 'GET', json, body, headers } = {}) {
  let response;
  try {
    response = await fetch(STUDIO + route, {
      method,
      headers: json !== undefined ? { 'content-type': 'application/json' } : headers,
      body: json !== undefined ? JSON.stringify(json) : body,
    });
  } catch (error) {
    throw new Exit(2, `连不上 H3 Studio（${STUDIO}）：${error.cause?.code ?? error.message}\n` +
      '它应该随开机启动；没在跑的话请用户启动它（h3-studio/scripts/start_server.bat），或用 H3_STUDIO_URL 指到它在的地址。');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Exit(1, data.error ?? `HTTP ${response.status} ${route}`);
  return data;
}

async function uploadImage(file) {
  const content = fs.readFileSync(file);
  const image = await api('/api/images', { method: 'POST', body: content, headers: { 'x-filename': encodeURIComponent(path.basename(file)) } });
  return { image, sha256: crypto.createHash('sha256').update(content).digest('hex') };
}

// --- output ---------------------------------------------------------------------

const print = (line = '') => process.stdout.write(line + '\n');
const minutes = (s) => (s >= 90 ? `${Math.round(s / 60)} 分钟` : `${Math.round(s)} 秒`);

function describeEstimate(e) {
  if (!e) return '没有新的要生成';
  const cold = e.coldStartSeconds ? `（含冷启动 ${minutes(e.coldStartSeconds)}）` : '';
  const cost = e.billedSeconds ? `，约 $${e.costUsd.toFixed(2)}` : '';
  const basis = e.samples ? `，按 ${e.samples} 条已有产出估` : '，还没有产出，按默认速度估';
  return `生成约 ${minutes(e.totalSeconds)}${cold}${cost}${basis}；不含下载时间`;
}

function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function runFileOf(target) {
  if (!target) throw new Exit(1, '要给输出目录或 video_run_*.json');
  if (fs.existsSync(target) && fs.statSync(target).isFile()) return path.resolve(target);
  if (!fs.existsSync(target)) throw new Exit(1, `找不到：${target}`);
  const runs = fs.readdirSync(target).filter((f) => f.startsWith(RUN_PREFIX) && f.endsWith('.json')).sort();
  if (!runs.length) throw new Exit(1, `${target} 里没有 ${RUN_PREFIX}*.json`);
  return path.resolve(target, runs.at(-1));
}

/** Copy a finished video next to the run file; returns its file name. */
async function collect(run, runFile, result, seed) {
  const dir = path.dirname(runFile);
  const ext = path.extname(result.path) || '.mp4';
  // Already here from an earlier run (a reused result): keep the one copy.
  const have = fs.readdirSync(dir).find((f) => f.endsWith(`_${result.id}${ext}`));
  if (have) return have;
  const name = `${run.stamp}_seed${seed ?? 'x'}_${result.id}${ext}`;
  const dest = path.join(dir, name);
  if (fs.existsSync(result.path)) {
    fs.copyFileSync(result.path, dest);
  } else {
    // Studio on another machine: fetch the file over HTTP.
    const response = await fetch(STUDIO + result.url);
    if (!response.ok) throw new Exit(1, `下载 ${result.url} 失败：HTTP ${response.status}`);
    fs.writeFileSync(`${dest}.part`, Buffer.from(await response.arrayBuffer()));
    fs.renameSync(`${dest}.part`, dest);
  }
  return name;
}

// --- commands -------------------------------------------------------------------

async function status() {
  const state = await api('/api/state');
  const comfy = await api('/api/comfy/status').catch((e) => ({ state: `unknown (${e.message})` }));
  const { batches = [], downloading = [], queued = [] } = await api('/api/cloud-batches');
  let target = '没有设置 ComfyUI 地址（请用户在 Studio 设置页填写）';
  if (state.config.comfyUrl) {
    const host = new URL(state.config.comfyUrl).host;
    target = state.runMode === 'cloud-batch' ? `Modal 云端批处理（${host}），按 GPU 时间计费` : `ComfyUI 队列（${host}）`;
  }
  print(`studio:  ${STUDIO}  ok`);
  print(`target:  ${target}`);
  print(`gpu:     ${comfy.state}${comfy.busy ? '，正在跑' : ''}`);
  print(`nodes:   ${state.hasObjectInfo ? `object_info 已有（${String(state.objectInfoUpdated).slice(0, 10)}）` : '缺 object_info.json，Studio 还不能转换工作流'}`);
  print(`price:   $${state.config.costPerHourUsd}/h（Studio 设置）`);
  const running = batches.filter((b) => b.status === 'running');
  print(`batches: ${running.length} 个在跑；${downloading.length} 条下载中，${queued.length} 条等下载`);
  if (!state.config.comfyUrl || !state.hasObjectInfo) throw new Exit(1, 'Studio 还不能生成，见上');
}

async function workflows(opts) {
  const list = await api(`/api/agent/workflows${opts.all ? '?all=1' : ''}`);
  if (opts.json) return print(JSON.stringify(list, null, 2));
  for (const w of list) {
    if (w.error) {
      print(`${w.workflow}\n    不能用：${w.error.split('\n')[0]}`);
      continue;
    }
    const needs = [w.needs.image && '图', w.needs.prompt && '提示词'].filter(Boolean).join(' + ') || '无输入';
    const d = w.defaults;
    print(`${w.workflow}\n    输入 ${needs} · 默认 ${d.duration ?? '?'} 秒 · ${d.megapixels ?? '?'} MP`);
    if (w.switches.length) print(`    开关：${w.switches.map((s) => `${s.title}${s.on ? '' : '(关)'}`).join('、')}`);
  }
}

async function presets(opts) {
  const list = await api('/api/agent/presets');
  if (opts.json) return print(JSON.stringify(list, null, 2));
  for (const c of list) print(`${c.id}  ${c.name}  [${c.workspace}]  ${c.workflow}${c.note ? `\n    ${c.note.split('\n')[0]}` : ''}`);
}

async function params(opts) {
  if (!opts.workflow && !opts.card) throw new Exit(1, 'params 要 --workflow 或 --card');
  const q = opts.card ? `card=${encodeURIComponent(opts.card)}` : `workflow=${encodeURIComponent(opts.workflow)}`;
  const p = await api(`/api/agent/params?${q}`);
  if (opts.json) return print(JSON.stringify(p, null, 2));
  print(p.workflow);
  for (const f of p.fields) {
    const value = typeof f.value === 'string' && f.value.length > 60 ? `${f.value.slice(0, 60)}…` : JSON.stringify(f.value);
    const role = f.role ? `  <${f.role}>` : '';
    // Node defaults like ±9.2e18 say nothing; show only real limits.
    const limit = (x) => (x != null && Math.abs(x) < 1e6 ? x : '');
    const range = limit(f.min) !== '' || limit(f.max) !== '' ? `  [${limit(f.min)}..${limit(f.max)}]` : '';
    const sw = f.switch ? `  (开关：${f.switch})` : '';
    print(`  ${f.id}  ${f.label} = ${value}${role}${range}${sw}`);
    if (f.options && f.type === 'combo') print(`      可选：${f.options.join(' | ')}`);
  }
  print('开关：');
  for (const s of p.switches) print(`  [${s.on ? 'x' : ' '}] ${s.title}`);
}

async function run(opts) {
  if (!opts.out) throw new Exit(1, 'run 要 --out <目录>（视频和记录写在这里）');
  if (!opts.workflow && !opts.card) throw new Exit(1, 'run 要 --workflow 或 --card（workflows / presets 可以列出来）');
  const prompt = opts['prompt-file'] ? fs.readFileSync(opts['prompt-file'], 'utf8') : opts.prompt;
  const body = {
    project: opts.project ?? projectName(),
    workflow: opts.workflow,
    card: opts.card,
    prompt,
    name: opts.name,
    dryRun: Boolean(opts['dry-run']),
    values: Object.fromEntries((opts.set ?? []).map((kv) => {
      const at = kv.indexOf('=');
      if (at < 1) throw new Exit(1, `--set 要写成 id=value：${kv}`);
      return [kv.slice(0, at), parseValue(kv.slice(at + 1))];
    })),
    groups: Object.fromEntries([...(opts.on ?? []).map((t) => [t, true]), ...(opts.off ?? []).map((t) => [t, false])]),
  };
  if (opts.seeds) body.seeds = opts.seeds.split(',').map((s) => Number(s.trim()));
  else {
    body.count = Number(opts.count ?? 1);
    if (opts['seed-start'] != null) body.seedStart = Number(opts['seed-start']);
  }
  if (opts.duration != null) body.duration = Number(opts.duration);
  if (opts.mp != null) body.megapixels = Number(opts.mp);

  let image = null;
  if (opts.image) {
    if (!fs.existsSync(opts.image)) throw new Exit(1, `找不到图片：${opts.image}`);
    // Uploading only stores the image in Studio's library; nothing runs yet.
    const up = await uploadImage(opts.image);
    body.imageId = up.image.id;
    image = { file: path.resolve(opts.image), sha256: up.sha256, studioId: up.image.id };
  }

  const res = await api('/api/agent/runs', { method: 'POST', json: body });
  const card = `${res.card.name}${res.card.new ? '（新卡片）' : ''}`;
  if (res.dryRun) {
    print(`dry-run · ${res.workspace} · ${card} · ${res.workflow}`);
    print(`新生成 ${res.count} 条（种子 ${res.seeds.join(', ') || '—'}）；已有可直接复用 ${res.reused.length} 条；正在生成中可等 ${res.joined.length} 条`);
    print(describeEstimate(res.estimate));
    print(res.mode === 'cloud-batch' ? '方式：Modal 云端批处理（花用户的 GPU 额度）' : '方式：ComfyUI 队列');
    return;
  }

  fs.mkdirSync(opts.out, { recursive: true });
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  let stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  for (let i = 2; fs.existsSync(path.resolve(opts.out, `${RUN_PREFIX}${stamp}.json`)); i++) stamp = `${stamp.split('-')[0]}-${i}`;
  const runFile = path.resolve(opts.out, `${RUN_PREFIX}${stamp}.json`);
  const record = {
    stamp,
    studio: STUDIO,
    createdAt: new Date().toISOString(),
    request: { ...body, imageId: undefined, image },
    workspace: res.workspace,
    card: res.card,
    workflow: res.workflow,
    mode: res.mode,
    batchId: res.batchId,
    estimate: res.estimate,
    jobs: res.jobs.map((j) => ({ id: j.id, seed: j.seed, state: j.state, error: j.error, resultId: null, file: null })),
    reused: [],
  };
  for (const r of res.reused) record.reused.push({ resultId: r.id, seed: r.seed, file: await collect(record, runFile, r, r.seed) });
  writeJson(runFile, record);
  print(record.jobs.length ? `已提交 ${record.jobs.length} 条 · ${res.workspace} · ${card}${res.batchId ? ` · 批次 ${res.batchId}` : ''}` : `没有新的要生成 · ${res.workspace} · ${card}`);
  if (record.reused.length) print(`复用已有 ${record.reused.length} 条：${record.reused.map((r) => r.file).join(', ')}`);
  if (record.jobs.length) print(describeEstimate(res.estimate));
  print(`记录：${runFile}`);
  if (opts.wait && record.jobs.length) await wait({ ...opts, _: [runFile] });
  else if (record.jobs.length) print(`等结果：node ${path.basename(process.argv[1])} wait "${runFile}"`);
}

async function wait(opts) {
  const runFile = runFileOf(opts._[0]);
  const record = JSON.parse(fs.readFileSync(runFile, 'utf8'));
  const deadline = Date.now() + Number(opts['timeout-min'] ?? 60) * 60000;
  const interval = Math.max(5, Number(opts.interval ?? 30)) * 1000;
  let last = '';
  for (;;) {
    const open = record.jobs.filter((j) => !FINAL.includes(j.state) || (j.state === 'done' && !j.file));
    if (open.length) {
      const states = await api(`/api/agent/jobs?ids=${open.map((j) => j.id).join(',')}`);
      for (const s of states) {
        const job = record.jobs.find((j) => j.id === s.id);
        Object.assign(job, { state: s.state, error: s.error });
        if (s.state === 'done' && s.result && !job.file) {
          job.resultId = s.result.id;
          job.file = await collect(record, runFile, s.result, job.seed);
          print(`  完成 种子 ${job.seed} -> ${job.file}`);
        }
        if (s.state === 'failed' || s.state === 'missing') print(`  失败 种子 ${job.seed}：${s.error ?? s.state}`);
        if (s.downloadSeconds != null) job.downloadSeconds = s.downloadSeconds;
      }
      writeJson(runFile, record);
    }
    const count = (state) => record.jobs.filter((j) => j.state === state).length;
    const summary = `${count('done')}/${record.jobs.length} 完成 · 生成中 ${count('running')} · 排队 ${count('waiting')} · 下载中 ${count('downloading')} · 失败 ${count('failed') + count('missing') + count('canceled')}`;
    if (summary !== last) print(`[${new Date().toLocaleTimeString()}] ${summary}`);
    last = summary;
    if (record.jobs.every((j) => FINAL.includes(j.state) && (j.state !== 'done' || j.file))) break;
    if (Date.now() > deadline) throw new Exit(5, `还没完（${summary}）。之后再运行：node ${path.basename(process.argv[1])} wait "${runFile}"`);
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  const failed = record.jobs.filter((j) => j.state !== 'done');
  print(`视频在 ${path.dirname(runFile)}`);
  if (failed.length) throw new Exit(4, `${failed.length} 条没有成功：${failed.map((j) => `种子 ${j.seed} ${j.error ?? j.state}`).join('；')}`);
}

async function cancel(opts) {
  const runFile = runFileOf(opts._[0]);
  const record = JSON.parse(fs.readFileSync(runFile, 'utf8'));
  const states = await api('/api/agent/cancel', { method: 'POST', json: { ids: record.jobs.map((j) => j.id) } });
  for (const s of states) Object.assign(record.jobs.find((j) => j.id === s.id), { state: s.state, error: s.error });
  writeJson(runFile, record);
  print(states.map((s) => `种子 ${s.seed}：${s.state}`).join('\n'));
}

const COMMANDS = { status, workflows, presets, params, run, wait, cancel };

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!COMMANDS[command]) {
    print(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 20).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    return command ? 1 : 0;
  }
  await COMMANDS[command](parseArgs(rest));
  return 0;
}

main().then((code) => process.exit(code), (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(error instanceof Exit ? error.code : 1);
});
