# 使用 SOP（面向人）

插件里同时带了一份**给 Agent 读的**同名手册（`skill("skill-distillation")` 可加载，源文件在
`engines/skill-distillation/SKILL.md`）。本文是给人看的那一份：**先决策、再执行、出问题怎么查**。

---

## 一、三条铁律

1. **代码做确定性的事，Agent 做语义的事。**
   抓取、解析、落盘、登记、路由打分、git 前置、编译 → 代码；
   理解内容、写正文、评分、判断该改哪个维度 → Agent。
2. **不知道就先自检，不要凭记忆猜路径。**
   `node <CLI> doctor`（或 `distill_doctor`）会逐项报告并给修复命令。
3. **不许编造输入。**
   扫描版 PDF / 图片 / 音视频**本工具不处理**，必须先在外部转成文本；没有文本就停下来问用户。

---

## 二、决策表

| 用户意图 | 走这条路 | 入口 |
|---|---|---|
| 文档站整站 → 一份文档 / 每页一个 Skill | 文档站批量 | **`docs`** |
| 单个网页 / 本地 md、txt、html、json | 抓取合并 | `source` |
| Git 仓库 → 结构分析 | 仓库提取 | `git` |
| ComfyUI 工作流 JSON | 工作流解析 | `comfy` |
| 已成文材料 → 新 Skill | 生成 | `source` + `skill` |
| 书 / 课程稿 → Skill 包 | 先出 Capability Bundle | cangjie 引擎的 Agent 流程 |
| 已编译好的 Bundle → Skill 包 | 确定性编译 | `cangjie --bundle` |
| 用 .md 强化**已有** Skill | 进化 | `evolve`（+ darwin 评审） |
| 「该用哪些 skill、什么顺序」 | 路由 | `route` |
| 「我生成过哪些 skill」 | 产出清单 | `list --generated` / 页面 |

---

## 三、标准流程

### A. 要一份资料（不落技能）

```
doctor → docs/source 抓取 → 读一遍 → 交给用户
```

### B. 要一个技能

```
doctor → 抓材料 → Agent 读材料并写成 body.md → skill 落盘 → list --generated 验证
```

### C. 要升级一个已有技能

```
evolve（建分支 + 落材料 + 出工单）→ Agent 按 darwin 评分与改写 → 回填 results.tsv
→ evolve --finalize --decision keep|revert
```

**关键**：`evolve` 只负责"接材料、留痕、可回滚"；**是否更好**由成对多数决判定，不由代码打分。

---

## 四、技能根与可见性（最容易踩的坑）

| rank | 根 | 说明 |
|---|---|---|
| 0 | DSH bundled | asar 内置 |
| 100 | `<cwd>/.dsh/skills` | 项目级（最高优先级） |
| **150** | **本插件 `engines/`** | 五个内置引擎 |
| 200 | `<cwd>/.agents/skills` | 项目级 |
| 300 | `extraSkillDirs` | 插件配置追加 |
| 400 | `$DSH_HOME/skills` | 用户级 |
| 500 | `$DSH_HOME/agents/skills` | 用户级 |

- **DSH 不读 `~/.claude/skills`**（上游引擎文档里最常见的错误假设）
- 同名时 **rank 小者胜**
- 路由键取**目录名**（nuwa 的 frontmatter 是 `huashu-nuwa`，目录名是 `nuwa-skill`，用后者）
- 想让官方技能列表也看到内置引擎：`node <CLI> engines export --target user`

---

## 五、边界（明确不承诺）

| 不承诺 | 原因 | 替代方案 |
|---|---|---|
| OCR / 扫描 PDF | 零依赖约束 | 外部先转文本（如系统的 OCR 工具） |
| 音视频转写 | 同上 | 外部 whisper / 字幕工具 |
| JS 渲染站点正文 | DSH 侧无浏览器 | 用站点的 `llms.txt` / `.md` 镜像 |
| PDF / EPUB / DOCX 直接解析 | 需要第三方依赖，`link:` 安装下无法解析 | 先转 Markdown |
| 自动 judge 打分 | 主观评分交 Agent | `evolve` 出工单，Agent 按 darwin 执行 |
| 云端处理 | 隐私 | 全部本地 |

---

## 六、排障口诀

```
先 engines list    →  内置引擎在不在
再 doctor          →  环境缺什么（它会给修复命令）
再看 list          →  技能根对不对、技能在不在
最后贴命令原文报错 →  错误信息本身通常已经点明原因
```

常见三条：

| 现象 | 结论 | 处理 |
|---|---|---|
| `uv 不在当前 PATH，但已在 ... 找到` | 装好了但 DSH 进程 PATH 是旧的 | 重启 DSH，或把 `config.cangjieUv` 指向该路径 |
| 工具调不到 / 页面说宿主未响应 | 宿主半边未加载 | 重启 DSH（客户端只需刷新页面） |
| `skill "x" not found` | 不在任何技能根，或 frontmatter 非法 | `list` 看根；`name` 必须匹配 `^[a-z0-9]+(?:-[a-z0-9]+)*$` |
