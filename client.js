/**
 * Client half of dsh-distillation.
 *
 * Delivers the plugin's own page: a sidebar panel entry plus the matching main panel
 * (the same "sidebar.panellist id ↔ main key" pairing the shipped Schedule plugin uses),
 * and an extra tab inside Settings → Plugins.
 *
 * Styling uses only --dsw-alias-* theme tokens; no Harness Client package is imported.
 */
window.__ModuleLoader__.load({
  id: 'dsh-distillation',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useState } = React;

    /** Panel id: the sidebar cell id and the main-panel key must match. */
    const PANEL_ID = 'distillation';
    /** Locale namespace for this plugin. */
    const NS = 'dsh-distillation';

    /** Bound in apply() through ctx.locale.bind(NS). */
    let translate = (key) => key;
    /** The Client locale service, captured in apply() for the render subscription. */
    let localeService = null;
    const t = (key) => {
      try {
        return translate(key);
      } catch {
        return key;
      }
    };

    const CLI = '%DSH_HOME%\\skills\\skill-distillation\\scripts\\cli.mjs';

    const S = {
      page: {
        width: '100%',
        minWidth: 0,
        height: '100%',
        minHeight: 0,
        overflow: 'hidden',
        display: 'flex',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
        lineHeight: 1.6,
      },
      /** The only scrolling element: the panel clips, this child owns the scroll. */
      scroll: {
        flex: '1 1 auto',
        minHeight: 0,
        overflowY: 'auto',
        overflowX: 'hidden',
        overscrollBehavior: 'contain',
        scrollbarGutter: 'stable',
      },
      content: {
        width: '100%',
        maxWidth: 960,
        margin: '0 auto',
        boxSizing: 'border-box',
        padding: '28px clamp(24px, 4vw, 48px) 48px',
        display: 'flex',
        flexDirection: 'column',
        gap: 18,
      },
      header: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      h1: { margin: 0, fontSize: 18, fontWeight: 600 },
      pill: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)',
        borderRadius: 999,
        padding: '1px 9px',
        fontSize: 11,
        color: 'var(--dsw-alias-label-secondary)',
      },
      dot: { width: 7, height: 7, borderRadius: '50%', background: 'var(--dsw-alias-state-success-primary)' },
      subtitle: { color: 'var(--dsw-alias-label-secondary)', margin: 0 },
      card: {
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 10,
        padding: '14px 16px',
      },
      h2: { margin: '0 0 8px', fontSize: 13, fontWeight: 600 },
      muted: { color: 'var(--dsw-alias-label-secondary)' },
      grid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
        gap: 10,
        marginTop: 10,
      },
      toolCard: {
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)',
        borderRadius: 8,
        padding: '10px 12px',
      },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
      code: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 11.5,
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 6,
        padding: '8px 10px',
        color: 'var(--dsw-alias-label-primary)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
        display: 'block',
        margin: 0,
        flex: '1 1 auto',
      },
      cmdRow: { display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 8 },
      btn: {
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: 6,
        padding: '4px 10px',
        fontSize: 11.5,
        cursor: 'pointer',
        flex: '0 0 auto',
      },
      footer: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11.5, marginTop: 4 },
    };

    const TOOLS = [
      ['distill_route', 'tool.route'],
      ['distill_comfyui', 'tool.comfy'],
      ['distill_sources', 'tool.sources'],
      ['distill_skill', 'tool.skill'],
      ['distill_evolve', 'tool.evolve'],
      ['distill_list', 'tool.list'],
    ];

    const COMMANDS = [
      ['cli.cmd.route', 'node "' + CLI + '" route --request "把这本书做成技能，然后优化它"'],
      ['cli.cmd.list', 'node "' + CLI + '" list'],
      ['cli.cmd.generated', 'node "' + CLI + '" list --generated'],
      ['cli.cmd.comfy', 'node "' + CLI + '" comfy "<workflow.json>" --out analysis.md --print'],
      ['cli.cmd.skill', 'node "' + CLI + '" skill --name my-skill --description "Use when ..." --body-file analysis.md'],
      ['cli.cmd.evolve', 'node "' + CLI + '" evolve --skill my-skill --from analysis.md'],
    ];

    const PROMPTS = [
      ['say.route', '我该用哪些技能来完成这件事：<需求>'],
      ['say.comfy', '解析这个 ComfyUI 工作流：<路径>'],
      ['say.web', '把这个网页整理成 md：<URL>'],
      ['say.skill', '把 analysis.md 做成一个 skill，名字叫 my-skill'],
      ['say.evolve', '用 analysis.md 进化 my-skill 这个技能'],
    ];

    /** Re-render when the active locale changes (LocaleFace: getSnapshot/subscribe). */
    function useLocaleRevision(locale) {
      const read = () => {
        try {
          return locale.getSnapshot().revision;
        } catch {
          return 0;
        }
      };
      const [revision, setRevision] = useState(read);
      useEffect(() => {
        if (!locale || typeof locale.subscribe !== 'function') return undefined;
        const off = locale.subscribe(() => setRevision(read()));
        return () => {
          try {
            off();
          } catch {
            /* already disposed */
          }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [locale]);
      return revision;
    }

    /** Copy-to-clipboard row used by both the commands and the example prompts. */
    function CopyRow(props) {
      const text = props.text;
      const [state, setState] = useState('idle');
      const copy = useCallback(async () => {
        try {
          await navigator.clipboard.writeText(text);
          setState('done');
        } catch {
          setState('error');
        }
        setTimeout(() => setState('idle'), 1600);
      }, [text]);
      const buttonText = state === 'done' ? t('ui.copied') : state === 'error' ? t('ui.copyFailed') : t('ui.copy');
      return h(
        'div',
        { style: S.cmdRow },
        props.label ? h('span', { style: { ...S.muted, flex: '0 0 92px', paddingTop: 8 } }, props.label) : null,
        h('code', { style: S.code }, text),
        h('button', { type: 'button', style: S.btn, onClick: copy, title: buttonText }, buttonText)
      );
    }

    /** Absolute path of the host snapshot route (the page and the route share one origin). */
    const STATUS_PATH = '/dsh-distillation/status';

    /**
     * Read the host's read-only snapshot: generated skills, skill roots, bundled
     * engines and the cached self-check. The browser cannot read the disk, so this
     * is the only live data the page has — and when the host half has not been
     * (re)loaded yet, the fetch simply fails and the page says so instead of
     * pretending the list is empty.
     */
    function useStatus() {
      const [state, setState] = useState({ phase: 'loading', data: null, error: '' });
      const load = useCallback((withDoctor) => {
        setState((prev) => ({ phase: prev.data ? 'refreshing' : 'loading', data: prev.data, error: '' }));
        fetch(STATUS_PATH + (withDoctor ? '?doctor=1' : ''), { headers: { accept: 'application/json' } })
          .then((response) => {
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return response.json();
          })
          .then((data) => setState({ phase: 'ready', data, error: '' }))
          .catch((error) => setState({ phase: 'unavailable', data: null, error: String((error && error.message) || error) }));
      }, []);
      useEffect(() => {
        load(false);
      }, [load]);
      return { reload: load, ...state };
    }

    const rowStyle = { display: 'flex', gap: 10, alignItems: 'baseline', padding: '6px 0', borderTop: '1px solid var(--dsw-alias-border-l1)' };
    const cellStyle = { ...S.muted, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };

    /** Generated-skill table + self-check panel, both fed by the host snapshot. */
    function StatusSection() {
      const status = useStatus();
      const data = status.data;
      const generated = (data && data.generated) || [];
      const doctor = data && data.doctor;
      const unavailable = status.phase === 'unavailable';

      const header = h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
        h('h2', { style: { ...S.h2, flex: '1 1 auto' } }, t('live.title')),
        h('button', { type: 'button', style: S.btn, onClick: () => status.reload(false) }, t('live.refresh')),
        h('button', { type: 'button', style: S.btn, onClick: () => status.reload(true) }, t('live.check'))
      );

      if (unavailable) {
        return h(
          'section',
          { style: S.card },
          header,
          h('div', { style: { ...S.muted, marginTop: 6 } }, t('live.unavailable')),
          h('div', { style: { ...S.muted, fontSize: 11.5, marginTop: 4 } }, 'fetch ', h('code', { style: S.mono }, STATUS_PATH), ' → ', status.error || 'error'),
          h(CopyRow, { text: 'node "' + CLI + '" list --generated', label: t('cli.cmd.generated') }),
          h(CopyRow, { text: 'node "' + CLI + '" doctor', label: t('live.check') })
        );
      }

      return h(
        'section',
        { style: S.card },
        header,
        data
          ? h(
              'div',
              { style: { ...S.muted, marginTop: 6 } },
              t('live.version') + ': ' + (data.version || '?') + ' · ' + t('live.engines') + ': ' + ((data.engines || []).length) + ' · ' + t('live.roots') + ': ' + ((data.roots || []).length)
            )
          : h('div', { style: { ...S.muted, marginTop: 6 } }, t('live.loading')),

        h('div', { style: { ...S.muted, marginTop: 12, fontWeight: 600 } }, t('live.generated') + ' (' + generated.length + ')'),
        generated.length === 0
          ? h('div', { style: { ...S.muted, marginTop: 4 } }, t('live.empty'))
          : h(
              'div',
              { style: { marginTop: 4 } },
              ...generated.slice(0, 20).map((item) =>
                h(
                  'div',
                  { style: rowStyle, key: item.name },
                  h('code', { style: { ...S.mono, flex: '0 0 190px' } }, item.name),
                  h('span', { style: { ...cellStyle, flex: '0 0 110px' } }, item.origin),
                  h('span', { style: { ...cellStyle, flex: '1 1 auto' } }, item.updatedAt ? String(item.updatedAt).slice(0, 16).replace('T', ' ') : ''),
                  h('span', { style: { ...cellStyle, flex: '1 1 240px' }, title: item.dir }, item.description || item.dir)
                )
              ),
              generated.length > 20 ? h('div', { style: { ...cellStyle, marginTop: 4 } }, '… +' + (generated.length - 20)) : null
            ),

        h('div', { style: { ...S.muted, marginTop: 14, fontWeight: 600 } }, t('live.doctor')),
        doctor
          ? h(
              'div',
              { style: { marginTop: 4 } },
              h(
                'div',
                { style: { ...S.muted, fontSize: 12 } },
                (doctor.ok ? '✅ ' : '⚠️ ') + 'ok ' + doctor.counts.ok + ' / warn ' + doctor.counts.warn + ' / fail ' + doctor.counts.fail + ' / skip ' + doctor.counts.skip + ' · ' + String(doctor.checkedAt || '').slice(0, 16).replace('T', ' ')
              ),
              ...(doctor.checks || [])
                .filter((check) => check.status !== 'ok')
                .slice(0, 6)
                .map((check) =>
                  h(
                    'div',
                    { style: { ...S.muted, fontSize: 12, marginTop: 4 }, key: check.id },
                    h('code', { style: S.mono }, '[' + check.status + ']'),
                    ' ' + check.label + '：' + check.detail,
                    check.fix ? h('div', { style: { ...S.muted, fontSize: 11.5 } }, '→ ' + check.fix) : null
                  )
                )
            )
          : h('div', { style: { ...S.muted, marginTop: 4 } }, t('live.noDoctor')),

        h('div', { style: { ...S.muted, marginTop: 14, fontWeight: 600 } }, t('live.hub')),
        h('div', { style: { ...S.muted, marginTop: 4, fontSize: 12 } }, t('live.hubNote')),
        h(CopyRow, { text: 'dsh plugin --profile desktop add dsh-skill-hub', label: t('live.hubInstall') })
      );
    }

    /** Sidebar entry: the owner supplies the square edge and the selected state. */    function DistillationIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 20;
      const active = !!(props && props.active);
      const stroke = active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)';
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          stroke,
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('path', { d: 'M5 4h14l-2 5H7z' }),
        h('path', { d: 'M8 9c0 4 1.8 6 4 6s4-2 4-6' }),
        h('path', { d: 'M12 15v4' }),
        h('path', { d: 'M9 20h6' })
      );
    }

    /** The plugin's main panel page. */
    function DistillationPage() {
      useLocaleRevision(localeService);
      // Three layers, copied from the shipped main-panel page: the panel root fills the
      // column and clips (height:100%, overflow:hidden); one inner child owns the scroll
      // (flex:1, min-height:0, overflow:auto); the content is width-capped inside it.
      return h(
        'div',
        { style: S.page },
        h(
          'div',
          { style: S.scroll },
          h(
            'div',
            { style: S.content },
            h(
              'div',
              { style: S.header },
              h('h1', { style: S.h1 }, t('title')),
              h('span', { style: S.pill }, h('span', { style: S.dot }), t('status')),
              h('span', { style: S.pill }, t('version'))
            ),
            h('p', { style: S.subtitle }, t('subtitle')),

            h(StatusSection),

            h(
              'section',
              { style: S.card },
              h('h2', { style: S.h2 }, t('tools.title')),
              h('div', { style: S.muted }, t('tools.note')),
              h(
                'div',
                { style: S.grid },
                ...TOOLS.map((pair) =>
                  h(
                    'div',
                    { style: S.toolCard, key: pair[0] },
                    h('code', { style: { ...S.mono, fontSize: 12 } }, pair[0]),
                    h('div', { style: { ...S.muted, marginTop: 4, fontSize: 12 } }, t(pair[1]))
                  )
                )
              )
            ),

            h(
              'section',
              { style: S.card },
              h('h2', { style: S.h2 }, t('cli.title')),
              h('div', { style: S.muted }, t('cli.note')),
              ...COMMANDS.map((pair) => h(CopyRow, { key: pair[0], text: pair[1], label: t(pair[0]) })),
              h('div', { style: { ...S.muted, fontSize: 11.5, marginTop: 8 } }, t('cli.hint'), ' ', h('code', { style: S.mono }, CLI))
            ),

            h(
              'section',
              { style: S.card },
              h('h2', { style: S.h2 }, t('say.title')),
              h('div', { style: S.muted }, t('say.note')),
              ...PROMPTS.map((pair) => h(CopyRow, { key: pair[0], text: pair[1], label: t(pair[0]) }))
            ),

            h('div', { style: S.footer }, t('footer'))
          )
        )
      );
    }

    const DICTIONARIES = {
      en: {
        title: 'Distillation',
        'panel.label': 'Distillation',
        status: 'running',
        version: 'v1.0.0',
        subtitle: 'Turn websites, documents, books, repositories and ComfyUI workflows into DSH skills.',
        'tools.title': 'Tools registered by this plugin',
        'tools.note': 'Callable by the agent right now; the CLI below runs the same engine outside a conversation.',
        'live.title': 'Live status',
        'live.refresh': 'Refresh',
        'live.check': 'Run self-check',
        'live.loading': 'Reading the host snapshot…',
        'live.unavailable': 'The host half of this plugin is not answering yet. If you just installed or updated it, restart DeepSeek Harness — the page itself hot-reloads, the host module does not. Until then use the commands below; they need no restart.',
        'live.version': 'version',
        'live.engines': 'bundled engines',
        'live.roots': 'skill roots',
        'live.generated': 'Skills this plugin produced',
        'live.empty': 'Nothing yet — distill or evolve a skill and it will appear here.',
        'live.doctor': 'Environment self-check',
        'live.noDoctor': 'No cached report. Press “Run self-check”.',
        'live.hub': 'All-skills hub (optional)',
        'live.hubNote': 'dsh-skill-hub browses, searches and toggles every skill; this page only lists what this plugin produced.',
        'live.hubInstall': 'install hub',
        'tool.route': 'Match the orchestrator index and return a structured routing plan (never executes it).',
        'tool.comfy': 'ComfyUI workflow JSON (UI or API format) → 8-section Markdown analysis.',
        'tool.sources': 'URLs plus .md/.txt/.html/.json files → one combined Markdown document.',
        'tool.skill': 'Write a skill bundle into a DSH skill root; loadable immediately.',
        'tool.evolve': 'Evolve an EXISTING skill with a Markdown document (archive + references/ + marker entry).',
        'tool.list': 'Report every DSH skill root and the skills it exposes; `generated` lists this plugin\'s own output.',
        'cli.title': 'Standalone CLI (no restart, no dependencies)',
        'cli.note': 'Run these in a shell; node 24 is on this machine.',
        'cli.hint': 'Script:',
        'cli.cmd.route': 'route a request',
        'cli.cmd.list': 'list roots',
        'cli.cmd.generated': 'list generated',
        'cli.cmd.comfy': 'parse workflow',
        'cli.cmd.skill': 'install skill',
        'cli.cmd.evolve': 'evolve skill',
        'say.title': 'Ask the agent',
        'say.note': 'Copy one of these into the chat.',
        'say.route': 'what to use',
        'say.comfy': 'workflow',
        'say.web': 'website',
        'say.skill': 'to skill',
        'say.evolve': 'evolve skill',
        'ui.copy': 'Copy',
        'ui.copied': 'Copied',
        'ui.copyFailed': 'Failed',
        footer: 'Host half: distill_* tools. Client half: this page (sidebar entry + main panel) and a Settings → Plugins tab.',
      },
      zh: {
        title: '蒸馏',
        'panel.label': '蒸馏',
        status: '运行中',
        version: 'v1.0.0',
        subtitle: '把网站、文档、书籍、Git 项目与 ComfyUI 工作流蒸馏成 DSH Skill。',
        'tools.title': '本插件注册的工具',
        'tools.note': 'Agent 现在就可以调用；下面的 CLI 在会话之外运行同一套引擎。',
        'live.title': '实时状态',
        'live.refresh': '刷新',
        'live.check': '运行自检',
        'live.loading': '正在读取宿主快照…',
        'live.unavailable': '插件宿主半边尚未响应。如果你刚安装或更新过它，请重启 DeepSeek Harness —— 页面会热更新，宿主模块不会。在此之前可先用下面的命令，它们不需要重启。',
        'live.version': '版本',
        'live.engines': '内置引擎',
        'live.roots': '技能根',
        'live.generated': '本插件产出的技能',
        'live.empty': '还没有产出 —— 蒸馏或进化一个技能后就会出现在这里。',
        'live.doctor': '环境自检',
        'live.noDoctor': '尚无缓存报告，点「运行自检」。',
        'live.hub': '全量技能入口（可选）',
        'live.hubNote': 'dsh-skill-hub 可以浏览、搜索、启停全部技能；本页只列出本插件的产出。',
        'live.hubInstall': '安装 hub',
        'tool.route': '匹配调度索引，返回结构化路由计划（只算不执行）。',
        'tool.comfy': 'ComfyUI 工作流 JSON（UI 或 API 格式）→ 8 节 Markdown 分析。',
        'tool.sources': 'URL 与 .md/.txt/.html/.json 文件 → 合并成一份 Markdown 文档。',
        'tool.skill': '把技能包写入 DSH 技能根，写盘即可被加载。',
        'tool.evolve': '用一份 Markdown 文档进化已有技能（归档原文 + references/ + 挂载条目）。',
        'tool.list': '列出所有 DSH 技能根及其暴露的技能；`generated` 列出本插件自己的产出。',
        'cli.title': '独立 CLI（无需重启、无依赖）',
        'cli.note': '在 shell 中执行；本机已装 node 24。',
        'cli.hint': '脚本路径：',
        'cli.cmd.route': '路由一个需求',
        'cli.cmd.list': '列出技能根',
        'cli.cmd.generated': '列出生成的技能',
        'cli.cmd.comfy': '解析工作流',
        'cli.cmd.skill': '安装技能',
        'cli.cmd.evolve': '进化技能',
        'say.title': '直接对 Agent 说',
        'say.note': '复制其中一条到对话框。',
        'say.route': '该用哪些技能',
        'say.comfy': '解析工作流',
        'say.web': '网页转 md',
        'say.skill': '做成技能',
        'say.evolve': '进化技能',
        'ui.copy': '复制',
        'ui.copied': '已复制',
        'ui.copyFailed': '复制失败',
        footer: '宿主半边：distill_* 工具。客户端半边：本页面（侧边栏入口 + 主面板）与 设置 → 插件 中的一个标签页。',
      },
    };

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          const disposers = [];
          for (const locale of Object.keys(DICTIONARIES)) {
            try {
              disposers.push(ctx.locale.register(NS, locale, DICTIONARIES[locale]));
            } catch {
              /* dictionary already owned; keep the bound translator */
            }
          }
          translate = ctx.locale.bind(NS);
          localeService = ctx.locale;
          return () => {
            for (const dispose of disposers) {
              try {
                dispose();
              } catch {
                /* idempotent */
              }
            }
          };
        });

        // Sidebar entry + its main panel (the cell id and the main key must match).
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, DistillationPage)
        );
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 20, locale: NS, label: () => t('panel.label') },
            DistillationIcon
          )
        );

        // Also expose the same page inside Settings → Plugins.
        ctx.slots.inject('settings.plugins.tab', () =>
          ctx.slots.register(
            { name: 'settings.plugins.tab', id: PANEL_ID, order: 20, locale: NS, label: () => t('title') },
            DistillationPage
          )
        );
      },
    };
  },
});
