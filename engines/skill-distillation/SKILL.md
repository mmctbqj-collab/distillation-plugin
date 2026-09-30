---
name: skill-distillation
description: 把网站、本地文档、书籍、Git 仓库与 ComfyUI 工作流转成 DSH Skill；用一份 .md 进化已有 Skill；列出本插件产出；为一句自然语言需求给出确定性路由计划。内置 nuwa/cangjie/darwin 引擎与 CLI，装好即可用。
when-to-use: 用户说「把这本书/这个网页/这个仓库/这个工作流做成 skill」「整理成册」「优化/进化某个 skill」「列出生成的技能」「该用哪个蒸馏 skill」时。
user-invocable: true
---

# 蒸馏 Skill —— dsh-distillation 内置执行手册（SOP）

这是随插件一起安装的**最简执行路径**。三条硬规则先记住：

1. **代码做确定性的事，Agent 做语义的事。** 抓取、解析、落盘、登记、路由打分由 CLI/工具做；
   理解内容、写正文、评分由 Agent 做。
2. **不知道就先自检。** 任何路径失败，先跑 `engines list` 与环境检查，不要凭记忆猜路径。
3. **不许编造输入。** 没有文本就停下来问用户（扫描版 PDF / 图片 / 音视频本工具**不处理**）。

---

## 0. 该走哪条路（先看这张表）

| 用户意图 | 走这条路 | 入口 |
|---|---|---|
| **文档站（整站）→ 一份文档 / 每页一个 Skill** | **文档站批量蒸馏** | **`docs`** |
| 网页 / 本地 md、txt、html、json → 一份 Markdown | 抓取合并 | `source` |
| ComfyUI 工作流 JSON → 8 节分析 | 工作流解析 | `comfy` |
| 一份已成文的材料 → 新 Skill | 生成 | `source` + `skill` |
| 一本书 / 课程稿 → Skill 包 | 仓颉引擎（先出 Capability Bundle） | `cangjie` 引擎的 Agent 流程 |
| 已编译好的 Capability Bundle → Skill 包 | 确定性编译 | `cangjie --bundle` |
| 用一份 .md 强化**已有** Skill | 进化 | `evolve` |
| Git 仓库 → 8 节仓库分析（结构/语言/入口/文档/示例/CI） | 仓库提取 | `git` |
| 「我该用哪些 skill、什么顺序」 | 路由 | `route` |
| 「我生成过哪些 skill」 | 产出清单 | `list --generated` |

---

## 1. 前置自检（30 秒）

```bash
node <skill-distillation>/scripts/cli.mjs engines list     # 内置引擎是否齐全
uv --version                                              # 只有 cangjie 需要
git --version                                             # 只有 evolve 的 git 前置需要
```

宿主侧还有两个工具：`distill_doctor`（逐项体检 + 修复指引）与 `distill_engines`（列出/导出内置引擎）。
缺 `uv` 时 `cangjie` 路径不可用，但 `source` / `comfy` / `skill` / `evolve` / `route` / `list` 全部照常 —— **不要因为缺 uv 就停掉整件事**。

`<skill-distillation>` 的两种取法（任选其一）：

- 插件内置（默认，装好即存在）：`<插件目录>/engines/skill-distillation/scripts/cli.mjs`
- 导出到技能根后：`$DSH_HOME/skills/skill-distillation/scripts/cli.mjs`

---

## 2. 抓取与解析（确定性，立即可用，不需要重启 DSH）

```bash
# 网站 / 本地文件 → 一份合并 Markdown
node cli.mjs source <url|file>... --out out.md [--title T] [--follow N] [--print]

# ComfyUI 工作流（UI 或 API 两种格式）→ 固定 8 节分析
node cli.mjs comfy <workflow.json> --out out.md [--title T] [--print]

# Git 仓库 → 8 节分析（远端自动 `--depth 1` clone 到临时目录，本地路径直读不 clone）
node cli.mjs git <url|dir> --out out.md [--branch B] [--title T] [--max-files N] [--print]

# 文档站整站 → 一份文档 / 每页一个 Skill（自动探测 llms.txt，详见 §2.1）
node cli.mjs docs <url> [--list] [--filter S|/regex/i] [--limit N] [--out f.md | --per-page]
```
`git` 的 8 节：这是什么 / 目录结构（深度 2）/ 语言占比（资源单独标注）/ 入口与构建 / 文档 / 示例 / 约定与 CI / 附录。
它**只读结构不读实现**——想真正理解仓库内容，再配合 `source` 抓 README 与 docs 页面。

`.md/.txt/.html/.json` 与 `http(s)` 都吃；ComfyUI 的 UI（`nodes`/`links`）与 API（`{id:{class_type}}`）两种形状都认。
退出码：`0` 成功、`1` 用法错误、`2` 运行错误。

### 2.1 文档站：先用 `docs` 入口（自动探测 llms.txt）

**不要**一页页猜 URL。给一个文档站 URL，`docs` 会：

1. 依次探测 `<origin>/llms.txt`、`<origin>/<路径前缀>/llms.txt`、`<origin>/llms-full.txt`；
2. 解析索引（llmstxt.org 约定：`- [标题](url): 说明`），**优先取 `.md` 镜像**（零 HTML 提取误差）；
3. 按 `--filter`（子串或 `/正则/i`）过滤**整个索引**，再取 `--limit N`；
4. 抓取并**合并成一份文档**（`--out f.md`），或 `--per-page` **每页装一个 Skill**（技能名取自 URL 路径，保证是合法 ASCII 技能 id）；
5. 站点没有 `llms.txt` 时，回退为同源链接跟随，并在文档里写明"该站没有 llms.txt"。

```bash
# 只看有哪些页可抓（不抓内容）
node cli.mjs docs https://docs.comfy.org/zh --list --limit 20
# 合并成一份文档
node cli.mjs docs https://docs.comfy.org/zh --filter '/custom-nodes/i' --limit 5 --out comfy-custom-nodes.md
# 每页一个 Skill（装进 $DSH_HOME/skills，落盘即被 provider 发现）
node cli.mjs docs https://docs.comfy.org/zh --filter '/custom-nodes/i' --limit 5 --per-page
```

实测 `docs.comfy.org/llms.txt`：**133 页，133 页全带 `.md` 镜像**。抓取失败的页面会列在 `failed` 里，不会中断整批。

现代文档站（VitePress / Next.js / Docusaurus）**首页和内容页的正文常常是客户端渲染的**：HTML 里
script 与导航占绝大多数，真正的文字极少。实测 `docs.comfy.org` 首页 566 KB HTML 里 385 KB 是 script、
69 KB 是 `<nav>`；一个内容页 627 KB HTML 只有 13 个 `<p>`。此时抓 HTML 只能得到几百到两千字。

**正确顺序**：

1. 先抓 `https://<站点>/llms.txt`（若存在）——它是站点自述的**全站索引**，纯文本；
2. 索引里通常直接给出每页的 **Markdown 镜像**（如 `https://docs.comfy.org/custom-nodes/overview.md`），
   以及按主题聚合的大文件（如 `/_llms/en/get-started.md` 聚合了 254 页、60 KB）；
3. 直接抓这些 `.md` —— 零 HTML 损失、零打分误差，`kind: text`；
4. 只有拿不到 `.md` 时才退回抓 HTML，并用 `--follow N` 跟随目录页。

实测：`docs.comfy.org/llms.txt` → 42 KB 索引；`/_llms/en/get-started.md` → 60 KB 纯 Markdown。**不要**
拿首页当文档源，那只是链接磁贴页。

---

## 3. 生成新 Skill

```bash
node cli.mjs skill --name my-skill --description "Use when ..." \
  [--when-to-use "触发场景"] [--body-file body.md] [--target user|project] \
  [--extra references/notes.md=./notes.md] [--print]
```

- `--name` 必须是小写 kebab（`^[a-z0-9]+(?:-[a-z0-9]+)*$`），否则宿主加载器会静默忽略。
- `--target user` → `$DSH_HOME/skills`（所有项目可见）；`project` → `<cwd>/.dsh/skills`（仅当前项目）。
- **落盘即被发现**：写进去立刻能 `skill("<name>")`，不需要重启、不需要触发事件。
- 同时写入 `.distillation.json`（产出登记），所以 `list --generated` 立刻能看到它。

先把 `source` 抓下来的材料读一遍，由你（Agent）写成 `--body-file`，再交给 `skill` 落盘 —— 别把整篇原文直接塞进去。

---

## 4. 仓颉路径（有 CLI，但需要 uv + Python）

```bash
node cli.mjs cangjie --bundle <verified-capability-bundle> \
  [--variant single|pack|auto] [--purpose learning|reference|workflow|distribution] \
  [--out DIR] [--target user|project] [--no-install] [--overwrite]
```

- 输入必须是**已验证的 Capability Bundle**（含 `verified.yaml`）。从原始书籍/课程稿产出 Bundle 是
  Agent 按 `cangjie-skill` 的流程做的事，**不是**这条命令做的事。
- 默认拒绝覆盖同名 Skill；确认要覆盖才加 `--overwrite`。
- 编译走 `uv run --with pyyaml python <cangjie>/scripts/cangjie.py compile ... --yes`，非交互。

---

## 5. 用 .md 进化已有 Skill

```bash
node cli.mjs evolve --skill <id|目录> (--from notes.md | --text "...") [--slug S] [--dry-run]
```

行为是**确定性合并**，不是语义改写：

1. 备份原 `SKILL.md` → `SKILL.md.bak.YYYYMMDD-HHMM`（同分钟重复执行自动加 `-2`）；
2. 材料落盘到 `<skill>/references/<slug>.md`（slug 默认取文件名）；
3. 在 `SKILL.md` 末尾维护**唯一一个** `<!-- distillation:enhancement start/end -->` 块，记录材料与日期；
4. `--dry-run` 只打印将要写入的内容。

**语义层面的改写与评分归 `darwin-skill`**（Agent 读它的文档执行）；这条路负责接材料、留痕、可回滚。

---

## 6. 路由与产出清单

```bash
node cli.mjs route --request "把这本书做成技能，然后优化它" [--cwd DIR] [--json]
node cli.mjs list [--cwd DIR] [--json] [--generated]
node cli.mjs engines list
node cli.mjs engines export --target user|project [--overwrite]
```

`route` **只算不跑**：返回结构化计划（命中哪些 skill、什么顺序、每步的硬门与产物、是否需要澄清）。
命中 0 个或多个同分候选时返回 `needsClarification: true` —— 这时**由你去问用户**，代码不会阻塞等待。

---

## 7. 技能根与可见性（DSH 与 Claude 不同）

| rank | 根 | 说明 |
|---|---|---|
| 0 | bundled | DSH 自带（asar 内） |
| 100 | `<cwd>/.dsh/skills` | 项目级，优先级最高 |
| **150** | **本插件的 `engines/`** | 内置引擎，随插件安装 |
| 200 | `<cwd>/.agents/skills` | 项目级（Agents 约定） |
| 300 | `extraSkillDirs` | 插件配置追加 |
| 400 | `$DSH_HOME/skills` | 用户级 |
| 500 | `$DSH_HOME/agents/skills` | 用户级（Agents 约定） |

- DSH **不读** `~/.claude/skills`（这是上游引擎文档里最常见的踩坑点）。
- 同名时 rank 小者胜；`skill("<目录名>")` 用**目录名**做路由键（nuwa 的 frontmatter `name` 是
  `huashu-nuwa`，但目录名是 `nuwa-skill`）。

---

## 8. 明确不承诺的事

- 无 OCR、无 whisper、无 ffmpeg：扫描 PDF、图片、音视频**必须先外部转成文本**。
- 无浏览器：JS 渲染的网站抓不到正文，只拿到 HTML。
- 无云端：所有处理在本机完成。
- `route` 只给计划，不替你执行。
- PDF / EPUB / DOCX 解析不在本版本范围内（零依赖约束）。

排障口诀：**先 `engines list` → 再 `distill_doctor` → 再贴命令原文报错**。
