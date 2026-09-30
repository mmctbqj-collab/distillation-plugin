# 使用指南（端到端）

本文所有命令都以插件目录下的 CLI 为例（把 `<CLI>` 替换成实际路径）：

```bash
# 插件内置副本（安装后即存在）
<CLI> = <插件目录>/engines/skill-distillation/scripts/cli.mjs
# 或导出到技能根之后
<CLI> = $DSH_HOME/skills/skill-distillation/scripts/cli.mjs
```

同一套能力在会话里由 Agent 通过 `distill_*` 工具调用，结果一致。

---

## 1. 文档站：一条命令搞定整站

```bash
# ① 先看这个站有哪些页可抓（只抓索引，不抓正文）
node <CLI> docs https://docs.comfy.org/zh --list --limit 20

# ② 合并成一份文档
node <CLI> docs https://docs.comfy.org/zh --filter '/custom-nodes|overview/i' --limit 5 \
     --out comfy-custom-nodes.md

# ③ 或者每页一个 Skill（写进 $DSH_HOME/skills，落盘即可被加载）
node <CLI> docs https://docs.comfy.org/zh --filter '/custom-nodes/i' --limit 5 --per-page
```

行为说明：

1. 按顺序探测 `<origin>/llms.txt` → `<origin>/<路径前缀>/llms.txt` → `<origin>/llms-full.txt`
2. 解析 llmstxt.org 约定的索引，**优先取 `.md` 镜像**（零 HTML 提取误差）
3. `--filter` 支持子串或 `/正则/i`，**对整份索引过滤**，再取 `--limit N`
4. 抓取失败的页面会列在 `failed` 里，不会中断整批
5. 站点没有 `llms.txt` 时自动回退成"同源链接跟随"，并在文档里写明

**实测** `docs.comfy.org`：索引 **133 页，133 页全带 `.md` 镜像**；`--per-page` 生成
`custom-nodes-intro` / `custom-nodes-overview` / `custom-nodes-walkthrough` 三个合法技能 id。

> 技能 id 从 URL 路径推导（丢掉 `zh/en` 语言前缀、去扩展名、丢弃非 ASCII 字符），
> 因为 DSH 要求 `^[a-z0-9]+(?:-[a-z0-9]+)*$` —— 中文标题直接 slugify 会生成**非法 id**。

---

## 2. 网页 / 本地文件 → 一份 Markdown

```bash
node <CLI> source <url|file>... --out out.md [--title T] [--follow N] [--print]
```

- HTML 会被 **readability 式打分**提取主容器（文本密度胜过链接密度，`nav/aside/footer/header/form` 先剥掉）
- 传输失败按 **指数退避重试**（400ms→8s），只重试网络错误与 408/425/429/5xx —— **404 绝不重试**
- `--follow N` 再跟随 N 个同源链接（默认 0，硬上限 `maxFollowPages`=5），合并进同一份文档
- 编码按 `<meta charset>` → `Content-Type` → UTF-8 逐级回退

**实测**：`nodejs.org/api/fs.html` 1.1 MB HTML → 246,799 字正文，导航残留 0；
`docs.python.org/.../pathlib.html` → 55,870 字，`section-container`。

> 纯 JS 渲染的站点抓不到正文（无浏览器）。这类站点请优先用 §1 的 `llms.txt` / `.md` 镜像。

---

## 3. Git 仓库 → 8 节分析

```bash
node <CLI> git <url|dir> --out repo.md [--branch B] [--max-files N]
```

- 远端：`git clone --depth 1` 到临时目录，跑完**显式清理**
- 本地路径：**直接读，不 clone**
- `node_modules/dist/build/target/vendor/.venv/...` 只计数不分析，并在报告里列出忽略了什么
- 语言占比会把 Image/Font/Archive/Media/Document 单独标注，并给一行
  「代码与文档占 X%，二进制资源占 Y%」——否则一个截图仓库会显示成 95% "Other"

**实测**：`alchaincyf/darwin-skill`（远端）38 文件、8 节齐全；
`cangjie-skill`（本地）319 文件、正确取到根 `README.md`（不是嵌套的 `benchmarks/toolbook/README.md`）。

---

## 4. ComfyUI 工作流 → 8 节解析

```bash
node <CLI> comfy <workflow.json> --out workflow.md [--title T] [--print]
```

UI 格式（`nodes`/`links`）与 API 格式（`{id:{class_type}}`）都认，输出固定 8 节：
这是什么 / 节点构成 / 模型与 LoRA / 采样参数 / 提示词 / 分组 / 执行链路 / 附录全节点。

---

## 5. 生成一个新 Skill

```bash
node <CLI> skill --name my-skill --description "Use when ..." \
  [--when-to-use "触发场景"] [--body-file body.md] [--target user|project] \
  [--extra references/notes.md=./notes.md] [--print]
```

- `--target user` → `$DSH_HOME/skills`（所有项目）；`project` → `<cwd>/.dsh/skills`
- **写盘即被发现**：立刻能 `skill("<name>")`，无需重启
- 同时写 `.distillation.json`（产出登记），`list --generated` 与页面立刻可见

推荐姿势：先 `source`/`docs` 把材料抓下来，由 **Agent 读一遍再写成 `--body-file`**，
不要把整篇原文直接塞进技能。

---

## 6. 用一份 `.md` 进化已有 Skill

```bash
# 前置：技能必须在一个 git 仓库里（否则明确报错、不留半成品）
node <CLI> evolve --skill my-skill --from notes.md [--git-init] [--judges 3] [--dry-run]

# 评审结束后归档
node <CLI> evolve --skill my-skill --finalize --decision keep|revert --run-id run-YYYYMMDD-HHMM --note "3 judges"
```

一次 `evolve` 会做（全部确定性）：

1. 解析 frontmatter，不合法直接失败（**不动任何东西**）
2. 检查是否在 git 仓库内；不在则报错，除非 `--git-init`
3. 缺 `test-prompts.json` 时按 description 派生骨架（**必须先改写成真实用例**）
4. 建分支 `auto-optimize/YYYYMMDD-HHMM` 并提交基线
5. 归档原 `SKILL.md` → `SKILL.md.bak.<时间戳>`，材料落 `references/<slug>.md`，
   维护唯一一个 `<!-- distillation:enhancement -->` 标记块
6. 写评估工单 `evolution/<run-id>/plan.md` + `results.tsv` 表头，judge 数强制奇数

**语义改写与评分归 Agent / `darwin-skill`**；`--finalize --decision revert` **只打印**
`git revert --no-edit HEAD`，**绝不**替你用 `git reset --hard`。

---

## 7. Capability Bundle → 真实 Skill 包（仓颉）

```bash
node <CLI> cangjie --bundle <verified bundle> \
  [--variant single|pack|auto] [--purpose learning|reference|workflow|distribution] \
  [--out DIR] [--target user|project] [--no-install] [--overwrite]
```

- 输入必须是**已验证的 Capability Bundle**（目录里含 `verified.yaml`）
- 从原始书/课程稿产出 Bundle 是 Agent 按 `cangjie-skill` 流程做的事，**不是**这条命令做的事
- 默认拒绝覆盖同名技能；`--overwrite` 才替换
- 实际执行 `uv run --with pyyaml python cangjie.py compile ... --yes`（非交互）

**实测**：《纳瓦尔宝典》Capability Bundle → `exit 0 in 421ms`，产出 26 个文件、
`name: naval-almanack` frontmatter 合法，安装后 `origin=cangjie-compile` 登记可见。

---

## 8. 路由与产出清单

```bash
node <CLI> route --request "把这本书做成技能，然后优化它" [--json]
node <CLI> list [--cwd DIR] [--json] [--generated]
node <CLI> engines list | export --target user|project [--overwrite]
node <CLI> doctor [--json]
```

`route` **只算不跑**：返回命中哪些 skill、什么顺序、每步的硬门与产物。
命中 0 个或多个同分候选时返回 `needsClarification: true` + 候选清单 —— **由 Agent 去问用户**，代码不阻塞。

---

## 9. 页面上的实时状态

侧边栏「蒸馏」页读到的是宿主只读路由 `GET /dsh-distillation/status`：

- 版本 / 内置引擎数 / 技能根数
- 本插件产出的技能表（名称、来源、时间、描述）
- 环境自检计数与未通过项（点「运行自检」即时跑一次）
- hub 安装命令（可选总入口）

宿主没响应时页面**不会假装列表为空**，而是提示需重启 DSH，并给出免重启的 CLI 命令。
