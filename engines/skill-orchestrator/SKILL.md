---
name: skill-orchestrator
description: |
  技能调度主入口：接收一句话需求，判断该用哪些子 Skill（造人 / 造书 / 进化），
  编排它们的调用顺序与依赖，汇总产物，并对产出的 Skill 触发迭代进化。
  触发词：「造skill」「蒸馏XX」「女娲」「仓颉」「达尔文」「把X做成skill」
  「提炼这本书」「优化我的skill」「进化skill」「这个skill再好一点」。
  English triggers: "orchestrate skills", "distill X into a skill", "book to skill",
  "optimize my skill", "evolve skill", "skill pipeline".
disable-model-invocation: false
user-invocable: true
---

# Skill Orchestrator（调度主 Skill）

**你只管说做什么，选哪个引擎、按什么顺序、产物放哪、要不要进化，由本 Skill 决定。**

## 0. 你（宿主 Agent）必须在开始时做的一件事

读取同目录的 `skills.index.json`。它是本调度器的**唯一事实来源**，包含每个子 Skill 的
`id / layer / kind / triggers / requires / produces / gaps`。

**不要凭记忆猜测子 Skill 的能力。** 若 `skills.index.json` 不存在或某个子 Skill 的
`installed` 为 `false`，先执行第 4 节的安装步骤，或明确告知用户缺哪个。

## 1. 意图路由表（第一层：确定性匹配）

用用户输入去匹配 `triggers`（中文与英文都要匹配）。命中多条时按 `priority` 取较高者。

| 用户说了什么 | 判定 | 调用 | 典型产物 |
|---|---|---|---|
| 一个人名 / 主题 /「XX的思维方式」/「思维顾问」 | `person` | `nuwa` | `[name]-perspective/` |
| 书 / 课程 / 视频 / 播客 / 附件文档 /「提炼方法论」 | `content` | `cangjie` | `books/<slug>/` → 编译后的 Skill 包 |
| 网站 URL / ComfyUI 工作流 JSON /「解析工作流」「把网页整理成 md」 | `content` | `skill-distillation` | 分析 `.md`，或直接落库的 `SKILL.md` |
| 「优化 / 进化 / 改进现有 skill」 | `evolution` | `darwin` | 就地改写的 `SKILL.md` + 评分日志 |
| 以上都像 / 同时提到人物与书 | `ambiguous` | 见第 3 节澄清门 | — |

**决策优先级（冲突时从上到下）**：

1. 用户**显式点名**了引擎（「用女娲」「走仓颉」）→ 直接用它，跳过自动路由。
2. 输入**是 URL / HTML / ComfyUI 工作流 JSON**，或用户要求「先解析成 md 再谈蒸馏」→
   `skill-distillation` 先产出文档；文档落盘后若还要编译成 Skill 包，再接 `cangjie`。
3. 输入**是附件/文件**且内容是作品（书、课、长文）→ `cangjie`。
   - 若附件是**非原生文本**（扫描 PDF / 图片 / 音视频）→ `skill-distillation` 同样做不到，
     必须停下让用户先提供文本，**禁止假装解析过**。
4. 输入主语**是活人**（乔布斯、张一鸣、我老板）→ `nuwa`。
5. 输入主语**是作品**（《穷查理宝典》、这门课）→ `cangjie`。
   - 注意边界：**从书里提炼"作者的方法论"仍走 `cangjie`**；**提炼"某人怎么想问题"走 `nuwa`**。
6. 全部不确定 → 走第 3 节澄清门，**不要瞎猜**。

## 2. 编排模型（第二层：组合与依赖）

单次请求常常需要**多个**子 Skill。按下面的模式组装流水线，并把实际计划**先告诉用户**再执行。

### 模式 A：单引擎直通
```
请求 → [nuwa | cangjie] → 产物
```

### 模式 B：内容蒸馏 → 编译 → 进化
```
cangjie 蒸馏(语义, agent 执行)
  → cangjie compile (CLI 确定性)
    → darwin 评估/改进/棘轮 (agent 执行)
```
适用：想让"造出来的书 Skill"一次性达到高质。

### 模式 C：造人 → 进化
```
nuwa 蒸馏 → darwin 优化
```
注：`nuwa` 的 Phase 5 **本身就内置了 darwin 的 8 维评估体系**（见 nuwa `README.md:252`）。
若你已跑完 nuwa Phase 5，**不要立刻再跑一遍 darwin**，否则重复计分。先用 darwin 的
`evaluate` 检查是否有 `weighted_gap` 大于阈值的维度再说。

### 模式 D：批量进化
```
遍历已安装 Skill 目录 → 对每个跑 darwin 的 Phase 0→3 → results.tsv 汇总
```

### 并行与串行
- `nuwa` Phase 1 需要 **6 个并行子 agent**；宿主不支持并行时降级为串行 6 轮
  （nuwa `SKILL.md:322`）。降级会显著变慢，**先告知用户**。
- `cangjie` Phase 1 需要 **5 个提取器并行**（`extractors/` 恰好 5 个 prompt）。
- `darwin` 的棘轮判定需要 **N=3 个独立 judge**（奇数次多数决）。

## 3. 澄清门（模糊时不硬猜）

满足任一条件就**必须先问**，最多 2 轮：

- 命中 `ambiguous`；
- 用户只说「帮我做个 skill」而没有主语；
- 无法判断主语是人还是作品。

澄清方式：给出 **1–3 个候选**，每个候选标注：**会用哪个引擎 / 会产出什么 / 大概花多久**。
不要默认替用户选。

## 4. 安装与前置检查（执行任何子 Skill 之前）

按顺序检查，缺什么就补什么：

| 检查项 | 命令 / 判据 | 缺失后果 |
|---|---|---|
| Python 3.10+ | `uv run python --version`（本机无 python 时由 uv 提供） | `cangjie` CLI 全废 |
| PyYAML | `uv run --with pyyaml python -c "import yaml"` | `cangjie` CLI 无法启动 |
| uv | `uv --version` | 上述两条都无法执行 |
| git | `git --version` | **darwin 无法回滚**（致命） |
| 目标目录是 git 仓库 | `git rev-parse --git-dir` | darwin 只能写 `.bak` 备份 |
| 子 Skill 已安装 | `skills.index.json` 各条 `installed` | 对应引擎不可用 |

一键自检：`uv run python verify_env.py`

**引擎从哪来**：nuwa / cangjie / darwin 三个引擎**随 `dsh-distillation` 插件内置**（插件包内 `engines/`），
插件自带的 SkillProvider 直接暴露它们 —— 装完即可 `skill("cangjie-skill")`，**不需要 git clone**。

只有在你想把它们落到用户技能根（供 DSH 官方技能列表或其他工具使用）时才需要导出：

```bash
node <skill-distillation>/scripts/cli.mjs engines list
node <skill-distillation>/scripts/cli.mjs engines export --target user
```

插件级安装（仅当前项目可见）用 `--target project`。

## 5. 调用子 Skill 的方式（关键：怎么"调用"）

三个子 Skill **都不是可调用 API**，它们是"给宿主 Agent 读的协议"。因此本 Skill 只有两种
真实调用手段：

1. **加载指令**：用 `skill` 工具加载子 Skill，得到其完整 `SKILL.md`，然后**按其中的流程执行**。
   - `skill("nuwa-skill")` → 拿到 39KB 女娲流程 → 按 Phase 0→5 走。
   - `skill("cangjie-skill")` / `skill("darwin-skill")` 同理。
2. **调用其确定性脚本**（只有 cangjie 有）：

```bash
# 环境自检（退出码可判）
uv run python <cangjie>/scripts/cangjie.py doctor

# Bundle → 可安装 Skill 包（含硬门校验、快照、原子发布）
uv run python <cangjie>/scripts/cangjie.py compile \
  --bundle <bundle-dir> --out <out-dir> --output single --yes

# 回滚
uv run python <cangjie>/scripts/cangjie.py rollback --pack <pack> --list
```

`<cangjie>/scripts/cangjie.py` 是**唯一** CLI 入口；`compile_single.build_tree(bundle, variant)`
与 `compile_pack.compile_pack_tree(bundle)` 可直接 import，返回 `{相对路径: 内容}`。

### 5.1 `skill-distillation` 的确定性 CLI（Node，零依赖，可立即用）

它同时也是本地 support 技能（`id: skill-distillation`，`callable: cli`），**不需要重启宿主**：

```bash
# 节点解释器优先序：node → DSH runtime bin（<DSH>/resources/runtime/bin/node.exe）
node <skill-distillation>/scripts/cli.mjs list --json
node <skill-distillation>/scripts/cli.mjs comfy <workflow.json> --out <out.md> --print
node <skill-distillation>/scripts/cli.mjs source <url|file>... --out <out.md>
node <skill-distillation>/scripts/cli.mjs skill --name <kebab> --description <D> \
  [--when-to-use <T>] [--target user|project] [--extra references/x.md=<localfile>]
```

退出码 0 成功 / 1 用法错误 / 2 运行错误。写出的 Skill **落盘即被宿主 provider 发现**，
不需要重启、不需要触发任何事件。

## 6. 产物与落库约定

| 引擎 | 产物位置 | 关键文件 |
|---|---|---|
| nuwa | `<skills>/[person]-perspective/` | `SKILL.md`、`FIDELITY.md`、`references/research/01-06.md` |
| cangjie | `books/<slug>/` → 编译输出 | `PIPELINE_STATE.md`、`.cangjie/capabilities/`、`BUILD_MANIFEST.json` |
| darwin | 就地改写目标 `SKILL.md` | `results.tsv`、`SKILL.md.bak.YYYYMMDD-HHMM` |
| skill-distillation | `<out>.md`（分析文档）或 `<skills>/<name>/`（新 Skill） | `SKILL.md` + 自定义附加文件；ComfyUI 固定 8 节 |

**登记**：每次产出后用 `verify_env.py --record <skill-name>` 更新 `skills.index.json` 的
`installed / artifacts / last_evolved`，否则下次路由会看不见它。

**技能根与优先级（DSH 与 Claude 不同）**：DSH 读 `<cwd>/.dsh/skills`(rank100)、
`<cwd>/.agents/skills`(200)、custom(300)、`$DSH_HOME/skills`(400)、`$DSH_HOME/agents/skills`(500)、
bundled(0)；**不读 `~/.claude/skills`**。同名时 rank 小者胜。
本插件另外挂了一个**内置引擎根（rank 150）**，直接把插件包内的 `engines/` 当作技能根，所以三个引擎
在插件装好后立刻可见、不需要任何复制。

**已知冲突（必须处理）**：nuwa 的 frontmatter `name` 是 `huashu-nuwa`，但安装目录名是
`nuwa-skill`；`huashu-skills` 里另有一个同名不同物的 `huashu-design`。**以目录名做路由键**，
`skills.index.json` 的 `id` 必须与目录名一致。

## 7. 进化闭环（用户要的"对子 Skill 迭代"）

darwin 负责这件事，但它是**散文协议，零引擎**，所以本 Skill 必须补上"谁来执行"：

```
evaluate(skill_dir)        → 9 维评分 + weighted_gap，用于排序，找出最短板
propose_edit(skill_dir, dim)→ 只针对 1 个维度生成改写（由你，宿主 LLM 执行）
judge_pair(before, after, N=3) → 3 个独立 judge 投票 better/worse/tie，多数决
apply_or_revert(verdict)   → 通过则 git commit，否则 git revert
log_row(results.tsv)       → 9 列历史
```

**硬性要求**：
- 前置必须有 `{skill}/test-prompts.json`（darwin Phase 0.5 生成 2–3 条），否则 dim8
  "实测表现" 等于编造，总分不可信。
- 每轮**只改 1 个维度**，改完必须**真跑测试**；无子 agent 时只能 `dry_run`，
  且 `dry_run > 30%` 要标记为不可信。
- 回滚只允许 `git revert HEAD`，**禁止 `git reset --hard`**（darwin `SKILL.md:226`）。
- 绝对分只做 triage，**棘轮判据是 paired 多数决**，不是"分数涨了就留下"。

## 8. 降级与失败处理

| 情况 | 降级动作 |
|---|---|
| 无并行子 agent | nuwa Phase 1 转串行 6 轮；darwin 转 dry_run |
| 无 WebSearch | nuwa 无法做网络调研 → 要求用户提供本地语料（PDF/字幕/转写稿） |
| 无 Python/PyYAML | cangjie 只剩语义阶段，`compile` 不可用 → 产物停在 `books/<slug>/` |
| 目标非 git 仓库 | darwin 退回 `.bak` 备份，**明确告知用户不可回滚** |
| 无 `test-prompts.json` | 拒绝运行 darwin 的评分，先补测试题 |
| 输入是扫描 PDF / 图片 / 音视频 | `skill-distillation` 也解析不了（无 OCR / whisper / ffmpeg）→ 让用户先给文本 |
| 宿主 `distill_*` 工具不可见 | 插件条目新增后不会热加载 → 改用第 5.1 节的 CLI，**不要谎称工具可用** |

## 9. 反例（不要做）

- ❌ 不要声称"已调度子系统执行"。**这些 Skill 没有进程级调度**，是你自己在执行它们的流程。
- ❌ 不要在 `skills.index.json` 缺失时凭印象编造子 Skill 能力。
- ❌ 不要把 `cangjie` 当成能处理 PDF/视频的转换器：它**只吃原生 Markdown/TXT**，
  音视频需外接转写（仓库内无 OCR/whisper/ffmpeg 代码）。
- ❌ 不要对**非 ComfyUI 形状**的 JSON 调用 `comfy`（它会报错），也不要手工编造节点分析。
- ❌ 不要在 nuwa Phase 5 刚跑完后无条件再跑 darwin 全流程。
- ❌ 不要为了"看起来在进化"而伪造 `FIDELITY.md` / `results.tsv` 数字。
