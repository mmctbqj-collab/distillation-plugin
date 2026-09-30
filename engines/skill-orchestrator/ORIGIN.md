# engines/skill-orchestrator — 本仓库自有内容

这个目录**不是**从上游 vendored 来的（所以没有 `UPSTREAM.json`）：

- `skills.index.json` 是本项目的**路由事实来源**，由本项目维护（每个技能的触发词、硬门、产物、已知缺陷）。
- `SKILL.md` 是本项目的调度 Skill 说明，供 Agent 读取后按文档执行。
- `verify_env.py` 是本项目的自检脚本（纯标准库，零第三方依赖）。

历史来源：本项目早期自有的调度 Skill 项目（同为本项目作者所有，非第三方上游）；内容已按 DSH 技能根约定
（`$DSH_HOME/skills`、`.dsh/skills`）改写，并移除了机器相关路径。

其它三个目录（`nuwa-skill`、`cangjie-skill`、`darwin-skill`）由 `build/vendor-engines.mjs`
从上游 MIT 仓库裁剪 + DSH 适配而来，来源、提交号、逐文件哈希与改写记录见各自的 `UPSTREAM.json`。
