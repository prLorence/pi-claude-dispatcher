window.__ModuleLoader__.load({
	id: '@pi-harness/dsh-plugin-harness-settings',
	factory(require) {
		const React = require('react');
		const h = React.createElement;

		const NS = 'harness-settings';

		const en = {
			title: 'Harness',
			subtitle: 'Local dsh plugins that drive plans, the vault, the monitor and provider usage.',
			configLabel: 'Config',
			statusLabel: 'Status',
			footnote: 'Status lines describe each plugin surface; this page does not poll a health API.',
			dispatchTitle: 'Harness Dispatch',
			dispatchDescription: 'Runs ready plans from .plans/inbox; trace, evidence and gate; dispatch_status, coding_subagent and audit_plan.',
			dispatchStatus: 'Config-driven; no live status endpoint.',
			vaultTitle: 'Harness Vault',
			vaultDescription: 'vault.mjs boot at session start and the orchestrator-only vault tools.',
			vaultStatus: 'Boots at session start; no live status endpoint.',
			projectsTitle: 'Harness Projects',
			projectsDescription: 'Git repositories as projects, and the warm repo-scoped vault context every session starts with.',
			projectsStatus: 'Live JSON at /plugins/harness-projects/state; Projects page in the sidebar.',
			monitorTitle: 'Harness Monitor',
			monitorDescription: 'Read-only board and transcripts served on dsh web routes.',
			monitorStatus: 'Read-only route /api/state.',
			usageTitle: 'Harness Usage',
			usageDescription: 'Sidebar provider usage/quota widget.',
			usageStatus: 'Live JSON at /plugins/harness-usage/state.',
		};

		const ROWS = [
			{
				id: 'harness-dispatch',
				titleKey: 'dispatchTitle',
				descriptionKey: 'dispatchDescription',
				statusKey: 'dispatchStatus',
				config: '.plans/config.json',
			},
			{
				id: 'harness-vault',
				titleKey: 'vaultTitle',
				descriptionKey: 'vaultDescription',
				statusKey: 'vaultStatus',
				config: 'skillRoot (default ~/.claude/skills/dispatch-plan)',
			},
			{
				id: 'harness-projects',
				titleKey: 'projectsTitle',
				descriptionKey: 'projectsDescription',
				statusKey: 'projectsStatus',
				config: 'registryPath (default ~/.dsh/harness-projects.json)',
			},
			{
				id: 'harness-monitor',
				titleKey: 'monitorTitle',
				descriptionKey: 'monitorDescription',
				statusKey: 'monitorStatus',
				config: 'harness-monitor plugin config (root, plansDir, prefix)',
			},
			{
				id: 'harness-usage',
				titleKey: 'usageTitle',
				descriptionKey: 'usageDescription',
				statusKey: 'usageStatus',
				config: 'harness-usage plugin config (providers, pollMs)',
			},
		];

		function Row({ row, t }) {
			return h(
				'li',
				{
					style: {
						display: 'grid',
						gap: 6,
						padding: '12px 14px',
						border: '1px solid rgba(127,127,127,.18)',
						borderRadius: 10,
						background: 'var(--dsh-surface-raised, rgba(127,127,127,.06))',
					},
				},
				h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
					h('strong', { style: { fontSize: 13 } }, t(row.titleKey)),
					h('span', { style: { fontSize: 10, opacity: 0.5, marginLeft: 'auto' } }, row.id),
				),
				h('div', { style: { fontSize: 12, lineHeight: 1.45, opacity: 0.82 } }, t(row.descriptionKey)),
				h('div', { style: { display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap', fontSize: 11 } },
					h('span', { style: { opacity: 0.5 } }, `${t('configLabel')}:`),
					h('code', { style: { fontSize: 11, padding: '1px 5px', borderRadius: 4, background: 'rgba(127,127,127,.14)' } }, row.config),
				),
				h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', fontSize: 11, opacity: 0.62 } },
					h('span', { style: { width: 6, height: 6, borderRadius: '50%', background: 'rgba(127,127,127,.65)', flex: '0 0 auto' } }),
					h('span', null, `${t('statusLabel')}: ${t(row.statusKey)}`),
				),
			);
		}

		function HarnessSettings({ t }) {
			return h(
				'section',
				{ 'aria-label': t('title'), style: { display: 'grid', gap: 14, padding: '4px 2px 18px', maxWidth: 640 } },
				h('header', { style: { display: 'grid', gap: 4 } },
					h('h2', { style: { margin: 0, fontSize: 18, fontWeight: 650 } }, t('title')),
					h('p', { style: { margin: 0, fontSize: 12, lineHeight: 1.5, opacity: 0.68 } }, t('subtitle')),
				),
				h('ul', { style: { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 10 } },
					...ROWS.map((row) => h(Row, { key: row.id, row, t })),
				),
				h('p', { style: { margin: 0, fontSize: 10.5, lineHeight: 1.45, opacity: 0.5 } }, t('footnote')),
			);
		}

		return {
			inject: ['slots', 'locale'],
			apply(ctx) {
				const t = ctx.locale.bind(NS);
				ctx.effect(() => ctx.locale.register(NS, 'en', en), 'harness-settings: copy');
				ctx.slots.inject('settings.section', () =>
					ctx.slots.register(
						{
							name: 'settings.section',
							id: 'harness',
							order: 15,
							label: () => t('title'),
							locale: NS,
							inject: () => ({ t }),
						},
						HarnessSettings,
					),
				);
			},
		};
	},
});
