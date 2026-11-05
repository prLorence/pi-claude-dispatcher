window.__ModuleLoader__.load({
	id: '@pi-harness/dsh-plugin-harness-dispatcher-ui',
	factory(require) {
		const React = require('react');
		const h = React.createElement;
		const PANEL_ID = 'dispatcher';
		const SETTINGS_URL = '/plugins/harness-dispatcher/settings';
		const MODELS_URL = '/plugins/harness-dispatcher/models';

		const ROWS = [
			{
				id: 'harness-dispatch',
				title: 'Harness Dispatch',
				description: 'Runs ready plans from .plans/inbox, writes trace/evidence and enforces the gate. Tools: dispatch_status, dispatch_project, coding_subagent and audit_plan.',
				config: '.plans/config.json',
				status: 'Per-session repository queue; explicit root via dispatch_project.',
			},
			{
				id: 'harness-vault',
				title: 'Harness Vault',
				description: 'vault.mjs boot at session start and the orchestrator-only vault tools. Workers never see the vault tools.',
				config: 'skillRoot (default ~/.claude/skills/dispatch-plan)',
				status: 'Boots at session start; no live health route.',
			},
			{
				id: 'harness-projects',
				title: 'Harness Projects',
				description: 'Git repositories as projects, with warm agent-vault context and the Projects sidebar page.',
				config: 'registryPath (default ~/.dsh/harness-projects.json)',
				status: 'Live JSON at /plugins/harness-projects/state.',
			},
			{
				id: 'harness-monitor',
				title: 'Dispatcher Monitor',
				description: 'Read-only plan board, lanes, transcripts and agent view. Renamed here; the server still mounts at /plugins/harness-monitor.',
				config: 'harness-monitor plugin config (root, plansDir, prefix)',
				status: 'Read-only route /api/state.',
			},
			{
				id: 'harness-usage',
				title: 'Harness Usage',
				description: 'Sidebar provider usage and quota widget for OpenCode Go and configurable endpoints.',
				config: 'harness-usage plugin config (providers, pollMs)',
				status: 'Live JSON at /plugins/harness-usage/state.',
			},
		];

		const CSS = `
.dp-root{height:100%;overflow:auto;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}
.dp-inner{max-width:1040px;margin:0 auto;padding:28px 30px 60px;display:grid;gap:20px}
.dp-head{display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap}
.dp-title{margin:0;font-size:20px;font-weight:650;letter-spacing:-.015em}
.dp-sub{margin:5px 0 0;font-size:12.5px;color:var(--dsw-alias-label-secondary);max-width:68ch}
.dp-tabs{display:inline-flex;gap:2px;padding:3px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-1);width:max-content}
.dp-tab{font:inherit;font-size:12px;font-weight:500;padding:6px 12px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dp-tab[aria-selected="true"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);box-shadow:0 0 0 1px var(--dsw-alias-border-l1)}
.dp-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dp-card{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:16px 18px;display:grid;gap:10px}
.dp-label{font-size:10.5px;font-weight:650;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);opacity:.8}
.dp-row{display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center;padding:9px 0;border-top:1px solid var(--dsw-alias-border-l1)}
.dp-row:first-of-type{border-top:0}
.dp-row-title{font-size:12.5px;font-weight:600}
.dp-row-desc{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:2px;max-width:72ch}
.dp-meta{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;color:var(--dsw-alias-label-secondary);margin-top:5px}
.dp-chip{font-size:10px;font-weight:600;padding:2px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dp-chip.ok{color:#34d399;border-color:rgba(52,211,153,.3);background:rgba(52,211,153,.08)}
.dp-field{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dp-select{font:inherit;font-size:12px;min-width:280px;padding:7px 9px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.dp-btn{font:inherit;font-size:12px;font-weight:500;padding:7px 12px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer}
.dp-btn:disabled{opacity:.5;cursor:default}
.dp-note{font-size:11px;color:var(--dsw-alias-label-secondary);margin:0}
.dp-msg{font-size:11.5px;color:var(--dsw-alias-label-secondary);min-height:16px}
.dp-frame-wrap{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}
.dp-frame-bar{display:flex;align-items:center;gap:10px;padding:9px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:11.5px;font-weight:600}
.dp-frame{display:block;width:100%;height:calc(100vh - 235px);min-height:420px;border:0;background:var(--dsw-alias-bg-base)}
.dp-error{font-size:12px;color:#f87171}
`;
		let cssInstalled = false;
		const installCss = () => {
			if (cssInstalled || typeof document === 'undefined') return;
			cssInstalled = true;
			const style = document.createElement('style');
			style.dataset.harnessDispatcher = 'true';
			style.textContent = CSS;
			document.head.appendChild(style);
		};

		function PanelIcon(props) {
			const size = props && typeof props.size === 'number' ? props.size : 18;
			return h(
				'svg',
				{ width: size, height: size, viewBox: '0 0 18 18', fill: 'none', 'aria-hidden': true, focusable: 'false' },
				h('circle', { cx: 9, cy: 9, r: 2.6, fill: 'currentColor' }),
				h('path', { d: 'M9 1.8v3.2M9 13v3.2M1.8 9h3.2M13 9h3.2M3.9 3.9l2.2 2.2M11.9 11.9l2.2 2.2M14.1 3.9l-2.2 2.2M6.1 11.9l-2.2 2.2', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
			);
		}

		function DispatcherPanel() {
			const [tab, setTab] = React.useState('settings');
			const [settings, setSettings] = React.useState(null);
			const [models, setModels] = React.useState([]);
			const [provider, setProvider] = React.useState('opencode-go');
			const [choice, setChoice] = React.useState('');
			const [busy, setBusy] = React.useState(false);
			const [message, setMessage] = React.useState('');
			const [error, setError] = React.useState('');
			React.useEffect(() => {
				installCss();
				let alive = true;
				window
					.fetch(SETTINGS_URL, { headers: { accept: 'application/json' } })
					.then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
					.then((data) => {
						if (!alive) return;
						setSettings(data);
						setChoice(data.ompModel || '');
						setModels(Array.isArray(data.models) ? data.models : []);
						setError('');
					})
					.catch((cause) => alive && setError(cause instanceof Error ? cause.message : String(cause)));
				return () => {
					alive = false;
				};
			}, []);
			const refreshModels = () => {
				setBusy(true);
				setMessage('');
				window
					.fetch(MODELS_URL, { headers: { accept: 'application/json' } })
					.then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
					.then((data) => {
						setModels(Array.isArray(data.models) ? data.models : []);
						setProvider((current) => (current === 'all' || data.models?.some((m) => m.provider === current) ? current : data.models?.some((m) => m.provider === 'opencode-go') ? 'opencode-go' : 'all'));
						setMessage(`Loaded ${data.models?.length ?? 0} authenticated models from omp.`);
					})
					.catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
					.finally(() => setBusy(false));
			};
			const save = () => {
				setBusy(true);
				setMessage('');
				window
					.fetch(SETTINGS_URL, {
						method: 'POST',
						headers: { 'content-type': 'application/json', accept: 'application/json' },
						body: JSON.stringify({ ompModel: choice }),
					})
					.then(async (r) => {
						const data = await r.json().catch(() => ({}));
						if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
						return data;
					})
					.then((data) => {
						setSettings(data);
						setModels(Array.isArray(data.models) ? data.models : models);
						setMessage(`Saved ${data.ompModel} as the omp default model.`);
						setError('');
					})
					.catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
					.finally(() => setBusy(false));
			};
			const header = h(
				'header',
				{ className: 'dp-head' },
				h(
					'div',
					null,
					h('h1', { className: 'dp-title' }, 'Dispatcher'),
					h('p', { className: 'dp-sub' }, 'The plan dispatcher, the omp coding-agent default, the project registry and the Dispatcher monitor.'),
				),
			);
			const tabs = h(
				'div',
				{ className: 'dp-tabs', role: 'tablist', 'aria-label': 'Dispatcher sections' },
				h('button', { type: 'button', role: 'tab', className: 'dp-tab', 'aria-selected': tab === 'settings', onClick: () => setTab('settings') }, 'Settings'),
				h('button', { type: 'button', role: 'tab', className: 'dp-tab', 'aria-selected': tab === 'monitor', onClick: () => setTab('monitor') }, 'Dispatcher monitor'),
			);
			const providers = [...new Set(models.map((m) => m.provider).filter(Boolean))].sort();
			const visible = provider === 'all' ? models : models.filter((m) => m.provider === provider);
			const modelCard = h(
				'section',
				{ className: 'dp-card' },
				h('div', { className: 'dp-label' }, 'omp coding agent'),
				h(
					'div',
					{ className: 'dp-field' },
					h(
						'select',
						{
							className: 'dp-select',
							value: provider,
							onChange: (e) => {
								const next = e.target.value;
								setProvider(next);
								const pool = next === 'all' ? models : models.filter((m) => m.provider === next);
								if (!pool.some((m) => m.id === choice)) setChoice(pool[0]?.id || '');
							},
							'aria-label': 'omp provider',
						},
						h('option', { value: 'all' }, `All authenticated providers (${models.length})`),
						providers.map((name) => h('option', { key: name, value: name }, `${name} (${models.filter((m) => m.provider === name).length})`)),
					),
					h(
						'select',
						{ className: 'dp-select', value: choice, onChange: (e) => setChoice(e.target.value), 'aria-label': 'omp default model' },
						!models.length
							? h('option', { value: choice || '' }, choice || 'Loading models…')
							: choice && !visible.some((m) => m.id === choice)
								? h('option', { value: choice }, `${choice} (current)`)
								: null,
						visible.map((m) => h('option', { key: m.id, value: m.id }, `${m.id}${m.context ? ` · ${m.context} ctx` : ''}`)),
					),
					h('button', { type: 'button', className: 'dp-btn', onClick: save, disabled: busy || !choice }, busy ? 'Saving…' : 'Set default'),
					h('button', { type: 'button', className: 'dp-btn', onClick: refreshModels, disabled: busy }, 'Refresh models'),
				),
				h('p', { className: 'dp-note' }, 'This writes omp’s global `modelRoles.default`. The provider filter defaults to OpenCode Go when omp is authenticated for it; `All authenticated providers` still lists the rest of the catalog.'),
				h('div', { className: 'dp-msg' }, message),
				error ? h('div', { className: 'dp-error' }, error) : null,
			);
			const pluginCard = h(
				'section',
				{ className: 'dp-card' },
				h('div', { className: 'dp-label' }, 'Harness plugins'),
				...ROWS.map((row) =>
					h(
						'div',
						{ className: 'dp-row', key: row.id },
						h(
							'div',
							null,
							h('div', { className: 'dp-row-title' }, row.title),
							h('div', { className: 'dp-row-desc' }, row.description),
							h('div', { className: 'dp-meta' }, row.config),
						),
						h('span', { className: 'dp-chip ok' }, 'Configured'),
					),
				),
				h('p', { className: 'dp-note' }, 'The old Harness settings page was removed; these are the same plugin rows, now in the Dispatcher.'),
			);
			const settingsView = h('div', { style: { display: 'grid', gap: 16 } }, modelCard, pluginCard);
			const monitorView = h(
				'div',
				{ className: 'dp-frame-wrap' },
				h(
					'div',
					{ className: 'dp-frame-bar' },
					h('span', null, 'Dispatcher monitor'),
					h('span', { style: { fontWeight: 400, opacity: 0.55 } }, 'read-only board, lanes, transcripts and agents'),
				),
				h('iframe', {
					className: 'dp-frame',
					src: '/plugins/harness-monitor/',
					title: 'Dispatcher monitor',
				}),
			);
			return h(
				'div',
				{ className: 'dp-root' },
				h('div', { className: 'dp-inner' }, header, tabs, tab === 'settings' ? settingsView : monitorView),
			);
		}

		return {
			inject: ['slots'],
			apply(ctx) {
				ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, DispatcherPanel));
				ctx.slots.inject('sidebar.panellist', () =>
					ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: 'Dispatcher' }, PanelIcon),
				);
			},
		};
	},
});
