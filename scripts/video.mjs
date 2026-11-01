#!/usr/bin/env node
// Video generation through H3 Studio (ComfyUI workflows on Modal or another ComfyUI).
// Node 18+, no dependencies. Every command needs Studio's folder: --studio <dir> or the
// H3_STUDIO_ROOT environment variable (only H3_STUDIO_URL is enough for a Studio on
// another machine).
//
//   node video.mjs status
//   node video.mjs start                                  # start Studio in the background
//   node video.mjs workflows [--all]
//   node video.mjs presets
//   node video.mjs params (--workflow W | --card C)
//   node video.mjs widgets (--workflow W | --card C) [--grep TEXT]   # every node parameter and group, and the workflow's notes
//   node video.mjs run (--workflow W | --card C) [--image F] [--upload F]... (--prompt T | --prompt-file F)
//                      [--seeds 1,2 | --count N [--seed-start S]] [--duration SEC] [--mp X]
//                      [--set id=value]... [--on switch|group]... [--off switch|group]...
//                      (--set id=@a.png uploads the image; id=@a.png,@b.png for an image list;
//                       {seed} in a text value becomes each video's seed)
//                      [--project P] [--name N] --out DIR [--dry-run] [--wait] [--timeout-min M] [--no-switch]
//   node video.mjs accounts [--use NAME]                  # Modal accounts, this month's credit; switch
//   node video.mjs wait <DIR | run.json> [--timeout-min M] [--interval SEC]
//   node video.mjs cancel <DIR | run.json>
//
// H3_STUDIO_URL: where Studio listens (default http://127.0.0.1:53290).
// Exit codes: 0 ok, 1 bad request or error, 2 Studio not running, 3 Studio folder not given or wrong,
//             4 some videos failed, 5 still running when --timeout-min ran out,
//             6 not enough Modal credit on any account.
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const STUDIO = (process.env.H3_STUDIO_URL ?? 'http://127.0.0.1:53290').replace(/\/+$/, '');
const STUDIO_REPO = 'https://github.com/WeissGoat/h3-studio';
let studioRoot = null; // Studio's folder, from --studio or H3_STUDIO_ROOT
const RUN_PREFIX = 'video_run_';
const FINAL = ['done', 'failed', 'canceled', 'missing'];

class Exit extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// --- arguments ------------------------------------------------------------------

const REPEATABLE = new Set(['set', 'on', 'off', 'upload']);
const FLAGS = new Set(['all', 'dry-run', 'wait', 'json', 'no-switch']);

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

// --- where Studio is -------------------------------------------------------------

const MISSING_HELP = `先告诉我 H3 Studio 在哪：--studio <目录>，或设用户环境变量 H3_STUDIO_ROOT
（Windows：setx H3_STUDIO_ROOT <目录>），或写在项目 AGENTS.md 的 video-gen 一节里。
还没有 Studio：它在 ${STUDIO_REPO}（私有仓库，要有权限）。clone 之前先问用户：
  git clone ${STUDIO_REPO}.git <目录>
  copy <目录>\\local.example.json <目录>\\local.json   (再填数据目录和工作流目录)
云端部署见 <目录>/cloud/README.md，由用户自己做。`;

function locateStudio(opts) {
  const given = opts.studio ?? process.env.H3_STUDIO_ROOT;
  if (!given) {
    if (process.env.H3_STUDIO_URL) return null; // a Studio on another machine has no local folder
    throw new Exit(3, `没有指定 H3 Studio 的目录。\n${MISSING_HELP}`);
  }
  const root = path.resolve(given);
  if (!fs.existsSync(path.join(root, 'server', 'index.mjs'))) throw new Exit(3, `${root} 不是 H3 Studio 的目录（没有 server/index.mjs）。\n${MISSING_HELP}`);
  return root;
}

const samePath = (a, b) => (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));

/** The running Studio must be the one in the given folder, or videos land in another data folder. */
async function checkStudio() {
  const state = await api('/api/state');
  if (studioRoot && state.root && !samePath(state.root, studioRoot)) {
    throw new Exit(3, `${STUDIO} 上跑的是另一个 Studio（${state.root}），不是 ${studioRoot}。请用户确认用哪个。`);
  }
  return state;
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
    throw new Exit(2, `H3 Studio 没在运行（${STUDIO}：${error.cause?.code ?? error.message}）。\n` +
      (studioRoot ? `启动它：node ${path.basename(process.argv[1])} start --studio "${studioRoot}"（本机服务，不花钱）` : '请用户启动它，或检查 H3_STUDIO_URL。'));
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

// --- Modal accounts and credit -------------------------------------------------

// Credit kept back on top of the estimate: Modal's usage figures lag by up to a few hours.
const CREDIT_MARGIN_USD = 1;

const money = (x) => `$${Number(x).toFixed(2)}`;

/** Accounts as Studio reports them, or null for a Studio without multi-account support. */
async function accountsInfo() {
  try {
    return await api('/api/agent/accounts');
  } catch (error) {
    if (error.code === 1 && /no route/.test(error.message)) return null;
    throw error;
  }
}

function describeAccount(a) {
  if (a.error) return `读不到用量（${a.error.split('\n')[0].slice(0, 120)}）`;
  const billed = a.billedUsd > 0 ? `，已开始扣费 ${money(a.billedUsd)}` : '';
  return `约剩 ${money(a.creditsLeftUsd)}（本月已用 ${money(a.creditsUsedUsd)} / ${money(a.monthlyCreditsUsd)}${billed}）`;
}

/**
 * Before spending GPU time on Modal: is there enough credit on the account in use?
 * If not, switch to the account with the most credit that covers it (unless --no-switch).
 * Returns a line for the user; throws Exit 6 when no account has enough.
 */
async function ensureCredit(costUsd, { dryRun, noSwitch }) {
  const info = await accountsInfo();
  if (!info || info.runMode !== 'cloud-batch' || !info.accounts.length) return null;
  const need = (costUsd ?? 0) + CREDIT_MARGIN_USD;
  const enough = (a) => !a.error && !(a.billedUsd > 0) && a.creditsLeftUsd >= need;
  const current = info.accounts.find((a) => a.name === info.inUse);
  if (!current || current.error) return `额度：账号 ${info.inUse ?? '?'} ${current ? describeAccount(current) : '不在账号列表里'}，没有检查`;
  if (enough(current)) return `额度：账号 ${current.name} ${describeAccount(current)}`;
  const why = current.billedUsd > 0 ? '已经在扣真钱' : `不够这次的约 ${money(costUsd ?? 0)}（另留 ${money(CREDIT_MARGIN_USD)} 余量）`;
  const next = info.accounts.filter((a) => a.name !== current.name && enough(a)).sort((a, b) => b.creditsLeftUsd - a.creditsLeftUsd)[0];
  const list = info.accounts.map((a) => `  ${a.name}${a.name === info.inUse ? ' (在用)' : ''}: ${describeAccount(a)}`).join('\n');
  if (!next) throw new Exit(6, `Modal 额度不够：账号 ${current.name} ${why}，其他账号也不够。\n${list}\n请用户决定：加账号、等下月额度，或接受扣费。`);
  if (noSwitch) throw new Exit(6, `Modal 额度不够：账号 ${current.name} ${why}。账号 ${next.name} 够用：video.mjs accounts --use ${next.name}\n${list}`);
  if (dryRun) return `额度：账号 ${current.name} ${why}；正式提交时会切到 ${next.name}（约剩 ${money(next.creditsLeftUsd)}）`;
  await api('/api/agent/account', { method: 'POST', json: { profile: next.name } });
  return `额度：账号 ${current.name} ${why}，已切到 ${next.name}（约剩 ${money(next.creditsLeftUsd)}）`;
}

// --- commands -------------------------------------------------------------------

async function start() {
  if (!studioRoot) throw new Exit(3, 'start 要先指定 Studio 的目录（--studio 或 H3_STUDIO_ROOT）');
  const up = () => fetch(`${STUDIO}/api/state`).then((r) => r.ok, () => false);
  if (await up()) {
    await checkStudio();
    return print(`已经在运行：${STUDIO}`);
  }
  // The server needs only Node itself; the web page needs `npm ci && npm run build` once.
  const log = path.join(studioRoot, 'runtime', 'server.log');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const out = fs.openSync(log, 'a');
  const port = new URL(STUDIO).port || '53290';
  const child = spawn(process.execPath, ['server/index.mjs', '--port', port], { cwd: studioRoot, detached: true, stdio: ['ignore', out, out], windowsHide: true });
  child.unref();
  for (let i = 0; i < 30; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (await up()) {
      print(`已启动：${STUDIO}（日志 ${log}）`);
      if (!fs.existsSync(path.join(studioRoot, 'web', 'dist', 'index.html'))) print('网页还没构建，用户要看页面时在 Studio 目录运行 npm ci 和 npm run build；Agent 接口不受影响。');
      return;
    }
  }
  throw new Exit(2, `Studio 30 秒内没有起来，看日志：${log}`);
}

async function status() {
  const state = await checkStudio();
  const comfy = await api('/api/comfy/status').catch((e) => ({ state: `unknown (${e.message})` }));
  const { batches = [], downloading = [], queued = [] } = await api('/api/cloud-batches');
  let target = '没有设置 ComfyUI 地址（请用户在 Studio 设置页填写）';
  if (state.config.comfyUrl) {
    const host = new URL(state.config.comfyUrl).host;
    target = state.runMode === 'cloud-batch' ? `Modal 云端批处理（${host}），按 GPU 时间计费` : `ComfyUI 队列（${host}）`;
  }
  print(`studio:  ${STUDIO}  ok  ${state.root ?? ''}`);
  print(`dirs:    数据 ${state.dataDir} · 工作流 ${state.workflowsDir}`);
  print(`target:  ${target}`);
  print(`gpu:     ${comfy.state}${comfy.busy ? '，正在跑' : ''}`);
  print(`nodes:   ${state.hasObjectInfo ? `object_info 已有（${String(state.objectInfoUpdated).slice(0, 10)}）` : '缺 object_info.json，Studio 还不能转换工作流'}`);
  print(`price:   $${state.config.costPerHourUsd}/h（Studio 设置）`);
  if (state.runMode === 'cloud-batch') {
    const info = await accountsInfo().catch(() => null);
    const current = info?.accounts.find((a) => a.name === info.inUse);
    if (current) print(`account: ${current.name} ${describeAccount(current)}${info.accounts.length > 1 ? `；共 ${info.accounts.length} 个账号（accounts 查看）` : ''}`);
  }
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
    print(`${w.workflow}${w.chain ? '  [接续：提示词用单独一行 --- 分段，--- 后可写这一段的设置]' : w.chainProblems ? `  [不能接续：${w.chainProblems.join('；')}]` : ''}\n    输入 ${needs} · 默认 ${d.duration ?? '?'} 秒 · ${d.megapixels ?? '?'} MP`);
    if (w.switches.length) print(`    开关：${w.switches.map((s) => `${s.title}${s.on ? '' : '(关)'}`).join('、')}`);
    if (w.stateful) print('    [有状态：每次提交接着云端上一次的结果做下一步，同样的参数也会重新生成]');
    if (w.notes) print('    [有说明：widgets 命令会显示，先读]');
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

async function widgets(opts) {
  if (!opts.workflow && !opts.card) throw new Exit(1, 'widgets 要 --workflow 或 --card');
  const q = opts.card ? `card=${encodeURIComponent(opts.card)}` : `workflow=${encodeURIComponent(opts.workflow)}`;
  const w = await api(`/api/agent/widgets?${q}`);
  if (opts.json) return print(JSON.stringify(w, null, 2));
  const grep = opts.grep?.toLowerCase();
  if (w.notes && !grep) print(`${w.notes.trim()}\n\n----`);
  print(w.workflow);
  const limit = (x) => (x != null && Math.abs(x) < 1e6 ? x : '');
  let area = undefined;
  for (const n of w.nodes) {
    const head = `${n.node} (${n.nodeType})`;
    const inputs = n.inputs.filter((i) => !grep || `${head} ${n.area ?? ''} ${i.id} ${i.input}`.toLowerCase().includes(grep));
    if (!inputs.length) continue;
    if (n.area !== area) print(`[${(area = n.area) ?? '不在分组里'}]`);
    print(`  ${head}${n.off ? '  (关)' : ''}`);
    for (const i of inputs) {
      const value = typeof i.value === 'string' && i.value.length > 60 ? `${i.value.slice(0, 60)}…` : JSON.stringify(i.value);
      const range = limit(i.min) !== '' || limit(i.max) !== '' ? `  [${limit(i.min)}..${limit(i.max)}]` : '';
      print(`    ${i.id} = ${value}  ${i.type}${range}${i.role ? `  <${i.role}>` : ''}`);
      if (i.options && i.type === 'combo') print(`        可选：${i.options.join(' | ')}`);
    }
  }
  if (grep) return;
  print('分组（--on / --off 分组名）：');
  for (const g of w.groups) print(`  [${g.on ? 'x' : ' '}] ${g.title}`);
}

/** --set values: JSON when it parses; "@file" (comma-separated for several) uploads images and becomes their Studio ids. */
async function setValues(list, uploads) {
  const values = {};
  for (const kv of list) {
    const at = kv.indexOf('=');
    if (at < 1) throw new Exit(1, `--set 要写成 id=value：${kv}`);
    const raw = kv.slice(at + 1);
    if (!raw.startsWith('@')) {
      values[kv.slice(0, at)] = parseValue(raw);
      continue;
    }
    const ids = [];
    for (const file of raw.split(',').map((f) => f.trim().replace(/^@/, '')).filter(Boolean)) {
      if (!fs.existsSync(file)) throw new Exit(1, `找不到图片：${file}`);
      const up = await uploadImage(file);
      uploads.push({ file: path.resolve(file), sha256: up.sha256, studioId: up.image.id, for: kv.slice(0, at) });
      ids.push(up.image.id);
    }
    values[kv.slice(0, at)] = raw.includes(',') ? ids : ids[0];
  }
  return values;
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
    values: {},
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
  // Extra images a chain prompt names on its "---" lines ("--- 参考图 2=hero"): uploaded, and the
  // file name there becomes the image's Studio id.
  const uploads = [];
  body.values = await setValues(opts.set ?? [], uploads);
  for (const file of opts.upload ?? []) {
    if (!fs.existsSync(file)) throw new Exit(1, `找不到图片：${file}`);
    const up = await uploadImage(file);
    uploads.push({ file: path.resolve(file), sha256: up.sha256, studioId: up.image.id });
  }
  if (uploads.length && body.prompt) {
    const ids = new Map(uploads.flatMap((u) => {
      const name = path.basename(u.file).toLowerCase();
      return [[name, u.studioId], [name.replace(/\.[^.]+$/, ''), u.studioId]];
    }));
    body.prompt = body.prompt.replace(/^[ \t]*-{3,}.*$/gm, (line) => line.replace(/([=＝]\s*)([^\s,，;；]+)/g, (m, eq, v) => (ids.has(v.toLowerCase()) ? eq + ids.get(v.toLowerCase()) : m)));
  }

  await checkStudio();
  // Price it first (a dry run saves nothing), so a Modal run can check the credit before spending it.
  const quote = await api('/api/agent/runs', { method: 'POST', json: { ...body, dryRun: true } });
  const credit = quote.mode === 'cloud-batch' && quote.count ? await ensureCredit(quote.estimate?.costUsd, { dryRun: body.dryRun, noSwitch: opts['no-switch'] }) : null;
  if (credit) print(credit);
  const res = body.dryRun ? quote : await api('/api/agent/runs', { method: 'POST', json: body });
  const card = `${res.card.name}${res.card.new ? '（新卡片）' : ''}`;
  if (res.dryRun) {
    print(`dry-run · ${res.workspace} · ${card} · ${res.workflow}`);
    print(`新生成 ${res.count} 条（种子 ${res.seeds.join(', ') || '—'}）；已有可直接复用 ${res.reused.length} 条；正在生成中可等 ${res.joined.length} 条`);
    if (res.segments) print(`接续：其中 ${res.segments} 条是分段，按顺序生成，最后一段下载后拼成整条`);
    print(describeEstimate(res.estimate));
    print(res.mode === 'cloud-batch' ? '方式：Modal 云端批处理（花用户的 GPU 额度）' : '方式：ComfyUI 队列');
    return;
  }

  fs.mkdirSync(opts.out, { recursive: true });
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const base = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  // A second run in the same second gets "_2", which sorts after the first, so `wait <dir>` finds the newest.
  let stamp = base;
  for (let i = 2; fs.existsSync(path.resolve(opts.out, `${RUN_PREFIX}${stamp}.json`)); i++) stamp = `${base}_${i}`;
  const runFile = path.resolve(opts.out, `${RUN_PREFIX}${stamp}.json`);
  const record = {
    stamp,
    studio: STUDIO,
    createdAt: new Date().toISOString(),
    request: { ...body, imageId: undefined, image, ...(uploads.length ? { uploads } : {}) },
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
    // The last segment of a chain also waits (a few minutes at most) for the joined video.
    const joinPending = (j) => j.chain && j.chain.index === j.chain.count && !j.joinedFile && j.state === 'done' && Date.now() < (j.joinUntil ?? Infinity);
    const open = record.jobs.filter((j) => !FINAL.includes(j.state) || (j.state === 'done' && !j.file) || joinPending(j));
    if (open.length) {
      const states = await api(`/api/agent/jobs?ids=${open.map((j) => j.id).join(',')}`);
      for (const s of states) {
        const job = record.jobs.find((j) => j.id === s.id);
        Object.assign(job, { state: s.state, error: s.error });
        if (s.chain) job.chain = { index: s.chain.index, count: s.chain.count };
        if (s.state === 'done' && s.result && !job.file) {
          job.resultId = s.result.id;
          job.file = await collect(record, runFile, s.result, job.seed);
          print(`  完成 种子 ${job.seed}${s.chain ? ` 段 ${s.chain.index}/${s.chain.count}` : ''} -> ${job.file}`);
          if (s.chain && s.chain.index === s.chain.count) job.joinUntil = Date.now() + 5 * 60000;
        }
        if (s.chain?.joined && !job.joinedFile) {
          job.joinedFile = await collect(record, runFile, s.chain.joined, job.seed);
          print(`  整条 种子 ${job.seed}（${s.chain.count} 段）-> ${job.joinedFile}`);
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
    if (record.jobs.every((j) => FINAL.includes(j.state) && (j.state !== 'done' || j.file) && !joinPending(j))) break;
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

async function accounts(opts) {
  await checkStudio();
  let info = await accountsInfo();
  if (!info) throw new Exit(1, '这个 Studio 还不支持多个 Modal 账号（更新 Studio）');
  if (opts.use) info = await api('/api/agent/account', { method: 'POST', json: { profile: opts.use } });
  if (opts.json) return print(JSON.stringify(info, null, 2));
  for (const a of info.accounts) print(`${a.name === info.inUse ? '*' : ' '} ${a.name}${a.workspace !== a.name ? ` (${a.workspace})` : ''}  ${describeAccount(a)}`);
  print(`在用：${info.inUse ?? '?'}${info.comfyUrl ? ` · ${new URL(info.comfyUrl).host}` : ''}`);
}

const COMMANDS = { status, start, workflows, presets, params, widgets, run, wait, cancel, accounts };

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!COMMANDS[command]) {
    const header = fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n');
    print(header.slice(1, header.findIndex((l) => l.startsWith('import'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    return command ? 1 : 0;
  }
  const opts = parseArgs(rest);
  studioRoot = locateStudio(opts);
  await COMMANDS[command](opts);
  return 0;
}

main().then((code) => process.exit(code), (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(error instanceof Exit ? error.code : 1);
});
