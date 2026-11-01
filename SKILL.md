---
name: video-gen
description: Use for AI video generation in any project - image-to-video (making a still image, character art or CG move), text-to-video, cutscenes, animated portraits, trailer or placeholder motion, several seed variants to pick from. Drives the user's local H3 Studio (github.com/WeissGoat/h3-studio), which runs MiniMax H3 ComfyUI workflows on a Modal GPU or another ComfyUI; the Studio folder must be given first (--studio or H3_STUDIO_ROOT). Covers locating and starting Studio, choosing a workflow or one of the user's tuned presets, a dry run for count, time and cost before spending GPU credits, checking Modal credit and switching to another of the user's Modal accounts when it runs out, submitting, waiting through slow downloads, copying the videos into the project with a record of every parameter, and reviewing frames. H3 prompts themselves are written with the h3-prompt skill.
---

# 通用 AI 视频生成

一条路：**指定并检查 Studio → 读工程约定 → 选预设或工作流 → 写提示词 → dry-run 报价 → 用户同意后提交 → 等待并取回 → 看帧挑选 → 交给工程入库**。

后端是用户本机的 **H3 Studio**（[WeissGoat/h3-studio](https://github.com/WeissGoat/h3-studio)，私有仓库）。Studio 负责把 ComfyUI 工作流转成 API、提交到云端或本地 ComfyUI、下载视频并记下全部参数。本 skill 只通过它的 HTTP 接口（默认 `http://127.0.0.1:53290`）工作，脚本是 `<skill>/scripts/video.mjs`（Node 18+，无依赖）。

## 0. 指定 Studio 目录，检查它（每个会话第一次生成前）

所有命令都要知道 Studio 的目录。按顺序找：

1. 项目 `AGENTS.md` / `CLAUDE.md` 的 video-gen 一节写了 Studio 路径：每条命令加 `--studio <目录>`；
2. 用户环境变量 `H3_STUDIO_ROOT`；
3. 都没有：**问用户 Studio 在哪**，不要自己在磁盘上搜。用户确认后，可以建议用户运行 `setx H3_STUDIO_ROOT <目录>` 设一次，或写进项目约定。

只有 Studio 在另一台机器上时，才可以只设 `H3_STUDIO_URL`、不给目录。

```bash
node <skill>/scripts/video.mjs status --studio <目录>
```

| 结果 | 怎么做 |
|---|---|
| 退出码 0 | 记下 target：`Modal 云端批处理` 会按 GPU 时间花用户的额度；`ComfyUI 队列` 是本地或别的机器。Modal 时 `account` 一行是在用账号本月约剩多少额度。 |
| 退出码 2（没在运行） | 运行 `video.mjs start --studio <目录>`。它在后台启动本机服务，只要 Node，不花钱。 |
| 退出码 3（没指定目录、目录不对，或端口上跑的是另一个 Studio） | 照提示问用户。用户还没有 Studio 时，它在私有仓库里：clone、填 `local.json` 都先问用户；云端部署（`cloud/README.md`）由用户自己做。 |
| 退出码 1（没设 ComfyUI 地址 / 缺 object_info） | 请用户在 Studio 设置页处理。Agent 不改 Studio 设置，不运行 `modal deploy/run`。 |

下文的命令都省略了 `--studio <目录>`。设了 `H3_STUDIO_ROOT` 时本来就可以不写。

## 1. 读工程约定

在工程的 `AGENTS.md` / `CLAUDE.md` 里找 video-gen 一节（模板见 [project-section.md](references/project-section.md)）：输出目录、默认预设、预算和审批方式、入库方式。

- 没有约定：视频放 `tmp/video_explore/<YYYYMMDD>_<主题>/`（确认它被 git 忽略），不往工程资产目录里写。
- `--project` 默认是当前 git 仓库名。同一工程的所有生成都进 Studio 里的 `Agent · <project>` 工作区，用户能在 Studio 的画布和产出页接着看、接着调。

## 2. 选预设或工作流

```bash
node <skill>/scripts/video.mjs presets                 # 用户在 Studio 画布上调好的卡片
node <skill>/scripts/video.mjs workflows               # cloud/ 下的工作流（已部署、验证过）；--all 列出全部
node <skill>/scripts/video.mjs params --card <id|名字>  # 或 --workflow <路径>：可改的参数、当前值、开关
node <skill>/scripts/video.mjs widgets --workflow <路径> [--grep 文字]  # 全部节点参数和分组，以及工作流自带的说明
```

- **优先用预设**（`--card`）：用户指定了卡片、或工程约定写了默认预设时一定用它。预设带着用户调好的模型、LoRA 和强度，卡片所在工作区的时长和分辨率也一起带上。
- 没有合适的预设才用 `--workflow`，参数保持工作流默认值。
- 只在用户要求或任务明确需要时改参数：`--duration 秒`、`--mp 百万像素`、`--set <参数id>=<值>`、`--on <开关>` / `--off <开关>`。参数 id 和开关名照 `params` 的输出原样写。
- 图生视频要 `--image`；`params` 里带 `<image>` / `<prompt>` 的就是要填的输入。
- **`params` 里没有的参数**：用 `widgets` 查。它列出每个节点的每个参数（id 写成 `<节点id>:<参数名>`）和 ComfyUI 里的每个分组。照样用 `--set` 和 `--on` / `--off` 改；改过的参数会出现在 Studio 的卡片上，用户能看到。图片参数写 `--set <id>=@文件`，会先上传；图片列表写 `@a.png,@b.png`。文字参数里的 `{seed}` 会换成每条视频的种子。
- **工作流带说明时**（`workflows` 列表里标 `有说明`）：先运行 `widgets`，读它开头的说明，再按说明填参数。说明写了这套工作流该怎么用、哪些参数要每次填。
- **长于 15 秒**：H3 单次最多 15 秒。用户的 Studio 里有接续工作流（`workflows` 列表里标 `接续`）时用它：每段约 5–10 秒，提示词里用单独一行 `---` 分段，一次提交整条链（见 5）。`---` 后面可以写下一段的设置，如 `--- 帧数=226 种子=9`、`--- LoRA=开`（名字照 `params` 里的参数名或开关名）；分辨率和模型不能按段改。工作流有第二张参考图时（如 `参考图 2` 开关），图用 `--upload <文件>` 一起传，`---` 后面写它的文件名：`--- 参考图 2=hero_side`。

- **有状态的工作流**（`workflows` 列表里标 `有状态`，例如用 Clip Bin 或 H3 Continuum Run 做长视频的）：每次提交都接着云端上一次留下的结果，做下一段。同样的参数再交也会重新生成，不会复用旧结果。一次提交就是一段：交一段，等用户看完、挑好，再按说明交下一段。用户的选择要照说明写进下一段的参数（例如接哪一条），不要替用户挑。同一条长视频的所有段，都要在同一个 Modal 账号上跑（加 `--no-switch`）。

## 3. 写提示词

- H3 工作流用 **h3-prompt** skill 写（首帧描述、动作节拍、镜头、声音）。
- 提示词写进文件，用 `--prompt-file` 传。记录文件里也会存一份全文，以后能原样重出。
- 图生视频先看清输入图，提示词跟图里已有的主体、构图和风格一致。

## 4. dry-run 报价，用户同意后再提交

```bash
node <skill>/scripts/video.mjs run --card <预设> --image in.png --prompt-file p.txt --count 3 --out <目录> --dry-run
```

dry-run 不生成，也不改 Studio 的画布（只把输入图存进 Studio 的图库）。它会给出：新生成几条、种子、能直接复用的已有视频、预计生成时间和费用。

- target 是 Modal 时，**把条数、时间、费用告诉用户，等用户同意再去掉 `--dry-run` 正式提交**。工程约定里写了预算的，在预算内可以直接提交，超出仍要问。
- 预估不含下载时间，只算生成。冷启动约 1.5 分钟；1 MP × 5 秒的视频，每条通常 45–90 秒。网速慢时，每条视频下载要好几分钟。
- target 是 Modal 时，dry-run 和正式提交都会先查额度（见 4.1），dry-run 输出的第一行就是。
- 同一工作流、参数、输入图、提示词和种子的组合，只会生成一次：再提交时直接复用已有的视频；如果还在生成，就等那一条，不会重复花钱。想要新变体，就换种子（`--seeds 1,2,3` 或 `--count N --seed-start S`）。

### 4.1 额度和多个 Modal 账号

用户可以在 Studio 里登记多个 Modal 账号（每个账号要用户自己登录、部署、下载模型）。

```bash
node <skill>/scripts/video.mjs accounts              # 每个账号本月约剩多少，* 是在用的
node <skill>/scripts/video.mjs accounts --use <账号>  # 切换在用账号
```

- `run` 提交到 Modal 前会先报价，再查在用账号的额度：约剩额度要够这次的预估费用再加 $1 余量（Modal 的用量数据会晚几小时）。账号已经开始扣真钱（`已开始扣费`）也算不够。
- 不够、而别的账号够：`run` **自动切到剩得最多的账号**再提交，输出里写着 `已切到 …`。把这件事告诉用户。dry-run 只说会切到哪个，不切。
- 所有账号都不够：退出码 6，不提交。把列出的各账号余额告诉用户，由用户决定（加账号、等下月额度，或接受扣费）。
- 用户要固定用某个账号时加 `--no-switch`：不够就退出码 6，不自动切。
- 切换只影响之后的提交。已经提交的批次记得自己的账号，照常同步和下载。
- 余额按每月 $30（Starter）估算，是估计值。`读不到用量` 时不检查，照常提交，并告诉用户额度没查到。

## 5. 提交、等待、取回

```bash
node <skill>/scripts/video.mjs run ... --out <目录>              # 提交后立即返回，写 <目录>/video_run_<时间>.json
node <skill>/scripts/video.mjs wait <目录> --timeout-min 9       # 等最新一次提交；也可以给 json 路径
node <skill>/scripts/video.mjs cancel <目录>                     # 取消；云端会停掉这一整批
```

- `wait` 每 30 秒查一次。完成一条，就把视频复制到输出目录，文件名是 `<时间>_seed<种子>_<结果id>.mp4`，进度也同步写回记录文件。中断后重跑 `wait` 会从上次停下的地方继续。
- 宿主命令有时间上限时（例如 10 分钟），用 `--timeout-min 9` 分几次等，或者放到后台跑。退出码 5 表示还没跑完，再运行一次 `wait` 即可。
- 接续工作流：每段是一条，按顺序在同一个批次里生成；最后一段下载后 Studio 把各段拼成整条，`wait` 也会把它取回（`整条 种子 N -> 文件`，最多多等 5 分钟）。改了某一段再提交，前面没改的段直接复用。一条链要在同一个 Modal 账号上跑完，所以中途不要换账号（需要时加 `--no-switch`）。
- 状态含义：`waiting` 在排队或等容器启动；`running` 正在生成；`downloading` 云端已经生成好，正在下载到本机；`done` 已完成；`failed` / `canceled` 失败或已取消。

| 退出码 | 含义 |
|---|---|
| 0 | 全部拿到 |
| 1 | 请求有误或 Studio 报错（信息里写了原因，比如参数 id 不存在、缺输入图） |
| 2 | 连不上 Studio |
| 4 | 有的失败了（逐条列出种子和错误） |
| 5 | 超时，还在跑 |
| 6 | Modal 额度不够，没有可切换的账号（或用了 `--no-switch`） |

失败时如实告诉用户哪几条、错误摘要。**不要悄悄换工作流、预设或改参数重试**。换了会改变效果，要先问用户。

## 6. 看结果、挑选

视频没法直接"看"：先抽帧拼成一张图，再看这张图。

```bash
python <skill>/scripts/frames.py <目录>/*.mp4 --frames 6 --out <目录>/_sheet.png
```

每条视频占一行，按时间均匀取帧，第一列就是首帧，所以几个种子可以上下直接对比。脚本需要 Pillow，再加 OpenCV 或 ffmpeg 其中之一（ffmpeg 可以在 PATH 上，也可以用 imageio-ffmpeg 自带的）。

- 先查硬伤：首帧和输入图对不上、人脸或身份漂移、服装或物件中途变样、肢体错乱、画面闪烁或崩坏、动作和提示词不符、主体被裁出画面。
- 声音和动作是否自然，抽帧看不出来。请用户在 Studio 产出页对比：左侧工作区选 `Agent · <project>`，几条视频同步播放。
- 拿不准的时候不要替用户拍板：给出拼图、推荐哪条和理由，请用户选。

## 7. 声明分级和边界

生成出来只代表**有了候选**。选定、入库、在工程里真正用上，各要各的证据，不越级声明。

- 不改 Studio 设置（唯一例外：用 `accounts --use` 或 `run` 的自动切换来换在用的 Modal 账号），不删 Studio 里的结果，不运行任何 `modal` 命令。加账号、部署、下载模型都由用户做。
- 不把候选手工覆盖进工程的正式资产目录。入库按工程约定或工程自己的 skill 走。
- 记录文件（`video_run_*.json`）里有提示词全文和输入图路径。工程不打算公开这些时，确认输出目录被 git 忽略。
- 直接调 Studio HTTP 接口（不用脚本）的写法见 [studio-api.md](references/studio-api.md)。
