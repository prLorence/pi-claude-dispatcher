window.__ModuleLoader__.load({
	id: '@pi-harness/dsh-plugin-harness-usage',
	factory(require) {
		const React = require('react');
		const h = React.createElement;

		const OK = '#34d399';
		const WARN = '#fbbf24';
		const BAD = '#f87171';
		const MUTED = '#8b93a7';
		const TRACK = 'rgba(127,127,127,.22)';
		const SOFT = 'rgba(127,127,127,.07)';
		const LINE = 'rgba(127,127,127,.13)';
		const CARD_WIDTH = 336;

		const STATUS = {
			ok: { text: 'OK', color: OK },
			limited: { text: 'Limited', color: WARN },
			'rate-limited': { text: 'Rate limited', color: WARN },
			unrecognized: { text: 'Unrecognized', color: WARN },
			'no-endpoint': { text: 'No endpoint', color: MUTED },
			'no-key': { text: 'No key', color: MUTED },
			'no-state': { text: 'No state', color: MUTED },
			unauthorized: { text: 'Unauthorized', color: BAD },
			unreachable: { text: 'Unreachable', color: BAD },
			error: { text: 'Error', color: BAD },
		};

		const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

		function rgba(hex, alpha) {
			const n = Number.parseInt(String(hex).slice(1), 16);
			if (!Number.isFinite(n)) return `rgba(127,127,127,${alpha})`;
			return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
		}

		function clampPercent(value) {
			if (typeof value !== 'number' || !Number.isFinite(value)) return null;
			return Math.max(0, Math.min(100, value));
		}

		/** A window's percent, from the normalized percent or from used/limit. */
		function windowPercent(item) {
			if (!item || typeof item !== 'object') return null;
			const explicit = clampPercent(item.percent);
			if (explicit !== null) return explicit;
			if (typeof item.used === 'number' && typeof item.limit === 'number' && Number.isFinite(item.used) && Number.isFinite(item.limit) && item.limit > 0) {
				return clampPercent((item.used / item.limit) * 100);
			}
			return null;
		}

		function percentColor(percent) {
			if (percent === null || percent === undefined) return MUTED;
			return percent >= 90 ? BAD : percent >= 70 ? WARN : OK;
		}

		function worstOf(windows) {
			let worst = null;
			for (const item of Array.isArray(windows) ? windows : []) {
				const percent = windowPercent(item);
				if (percent === null) continue;
				if (worst === null || percent > worst.percent) {
					worst = {
						percent,
						label: item.label || item.key || 'Window',
						resetsAt: typeof item.resetsAt === 'number' && Number.isFinite(item.resetsAt) ? item.resetsAt : null,
					};
				}
			}
			return worst;
		}

		function money(value, unit) {
			if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
			if (unit === 'USD') return `$${value.toFixed(2)}`;
			return value.toLocaleString();
		}

		function pad2(value) {
			return value < 10 ? `0${value}` : String(value);
		}

		function formatAbsolute(ms) {
			const date = new Date(ms);
			if (Number.isNaN(date.getTime())) return '';
			return `${pad2(date.getDate())} ${MONTHS[date.getMonth()]} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
		}

		function formatCountdown(ms, now) {
			const diff = ms - now;
			if (!(diff > 0)) return 'now';
			const minutes = Math.ceil(diff / 60000);
			if (minutes < 60) return `${minutes}m`;
			const hours = Math.floor(minutes / 60);
			const rest = minutes % 60;
			if (hours < 24) return rest ? `${hours}h ${rest}m` : `${hours}h`;
			const days = Math.floor(hours / 24);
			const restHours = hours % 24;
			if (days < 30) return restHours ? `${days}d ${restHours}h` : `${days}d`;
			return `${Math.floor(days / 30)}mo`;
		}

		function formatAgo(ms, now) {
			const seconds = Math.max(0, Math.round((now - ms) / 1000));
			if (seconds < 5) return 'just now';
			if (seconds < 60) return `${seconds}s ago`;
			const minutes = Math.round(seconds / 60);
			if (minutes < 60) return `${minutes}m ago`;
			const hours = Math.round(minutes / 60);
			if (hours < 24) return `${hours}h ago`;
			return `${Math.round(hours / 24)}d ago`;
		}

		function Donut({ percent, size = 60, thickness = 6, color = OK, showCenter = true }) {
			const pct = clampPercent(percent);
			const radius = (size - thickness) / 2;
			const circumference = 2 * Math.PI * radius;
			const arc = pct === null ? 0 : (pct / 100) * circumference;
			const centerFont = size >= 56 ? 13 : size >= 40 ? 11 : 9;
			return h(
				'div',
				{ style: { position: 'relative', width: size, height: size, flex: '0 0 auto' } },
				h(
					'svg',
					{ width: size, height: size, viewBox: `0 0 ${size} ${size}`, 'aria-hidden': true, focusable: 'false' },
					h('circle', { cx: size / 2, cy: size / 2, r: radius, fill: 'none', stroke: TRACK, strokeWidth: thickness }),
					arc > 0
						? h('circle', {
								cx: size / 2,
								cy: size / 2,
								r: radius,
								fill: 'none',
								stroke: color,
								strokeWidth: thickness,
								strokeLinecap: 'round',
								strokeDasharray: `${arc} ${circumference - arc}`,
								transform: `rotate(-90 ${size / 2} ${size / 2})`,
								style: { transition: 'stroke-dasharray .35s ease, stroke .2s ease' },
							})
						: null,
				),
				showCenter
					? h(
							'div',
							{
								style: {
									position: 'absolute',
									top: 0,
									left: 0,
									right: 0,
									bottom: 0,
									display: 'flex',
									alignItems: 'center',
									justifyContent: 'center',
									fontSize: centerFont,
									fontWeight: 600,
									fontVariantNumeric: 'tabular-nums',
									letterSpacing: '-.02em',
									opacity: pct === null ? 0.4 : 0.92,
								},
							},
							pct === null ? '—' : `${Math.round(pct)}%`,
						)
					: null,
			);
		}

		function chipStyle(color, tint) {
			return {
				display: 'inline-flex',
				alignItems: 'center',
				height: 17,
				padding: '0 7px',
				borderRadius: 999,
				fontSize: 9.5,
				fontWeight: 600,
				letterSpacing: '.01em',
				whiteSpace: 'nowrap',
				flex: '0 0 auto',
				maxWidth: 120,
				overflow: 'hidden',
				textOverflow: 'ellipsis',
				color,
				background: rgba(color, tint),
				border: `1px solid ${rgba(color, tint + 0.1)}`,
			};
		}

		function statusDot(color) {
			return h('span', {
				style: {
					width: 7,
					height: 7,
					borderRadius: '50%',
					background: color,
					boxShadow: `0 0 0 2.5px ${rgba(color, 0.16)}`,
					flex: '0 0 auto',
					marginLeft: 1,
				},
			});
		}

		function windowCell(item, now) {
			const percent = windowPercent(item);
			const color = percentColor(percent);
			const label = item.label || item.key || 'Window';
			const resetsAt = typeof item.resetsAt === 'number' && Number.isFinite(item.resetsAt) ? item.resetsAt : null;
			const remaining = typeof item.remaining === 'number' && Number.isFinite(item.remaining) ? item.remaining : null;
			const resetText = !resetsAt && typeof item.resetText === 'string' && item.resetText.trim() !== '' ? item.resetText.trim() : null;
			const tooltip = [`${label}: ${percent === null ? 'no data' : `${Math.round(percent)}%`}`];
			if (typeof item.used === 'number' && typeof item.limit === 'number') {
				tooltip.push(`${money(item.used, item.unit)} / ${money(item.limit, item.unit)}`);
			}
			if (remaining !== null) tooltip.push(`remaining ${money(remaining, item.unit)}`);
			if (resetsAt) tooltip.push(`resets ${formatAbsolute(resetsAt)}`);
			return h(
				'div',
				{
					key: item.key || label,
					title: tooltip.join(' · '),
					style: { display: 'grid', justifyItems: 'center', gap: 4, minWidth: 0, padding: '2px 0 0' },
				},
				h(Donut, { percent, size: 60, thickness: 6.5, color }),
				h('span', { style: { fontSize: 10, fontWeight: 600, opacity: 0.78, whiteSpace: 'nowrap' } }, label),
				remaining !== null && percent === null
					? h('span', { style: { fontSize: 10, opacity: 0.72, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' } }, money(remaining, item.unit))
					: null,
				resetsAt
					? h(
							'span',
							{
								style: {
									fontSize: 9,
									opacity: 0.45,
									fontVariantNumeric: 'tabular-nums',
									whiteSpace: 'nowrap',
								},
							},
							`resets ${formatCountdown(resetsAt, now)}`,
						)
					: resetText
						? h('span', { style: { fontSize: 9, opacity: 0.45, whiteSpace: 'nowrap' } }, `resets ${resetText}`)
						: null,
			);
		}

		function noteRow(key, text) {
			return h(
				'p',
				{ key, style: { margin: '1px 0 0', fontSize: 10.5, lineHeight: 1.5, opacity: 0.62 } },
				text,
			);
		}

		function rawRow(raw) {
			return h(
				'details',
				{ key: 'raw', style: { marginTop: 2 } },
				h(
					'summary',
					{ style: { fontSize: 9.5, opacity: 0.4, cursor: 'pointer' } },
					'Raw response',
				),
				h(
					'pre',
					{
						style: {
							margin: '6px 0 0',
							padding: 8,
							borderRadius: 8,
							background: SOFT,
							fontSize: 9,
							lineHeight: 1.5,
							maxHeight: 140,
							overflow: 'auto',
							whiteSpace: 'pre-wrap',
							wordBreak: 'break-word',
							opacity: 0.62,
						},
					},
					raw,
				),
			);
		}

		function ProviderCard({ provider, now }) {
			const windows = Array.isArray(provider.windows) ? provider.windows : [];
			const status = STATUS[provider.status] || {
				text: provider.status ? String(provider.status) : 'Unknown',
				color: MUTED,
			};
			const rows = [];
			if (windows.length) {
				rows.push(
					h(
						'div',
						{
							key: 'windows',
							style: {
								display: 'grid',
								gridTemplateColumns: 'repeat(auto-fit, minmax(72px, 1fr))',
								gap: 6,
								marginTop: 2,
							},
						},
						windows.map((item) => windowCell(item, now)),
					),
				);
			}
			if (!windows.length && provider.message) rows.push(noteRow('message', provider.message));
			if (provider.raw) rows.push(rawRow(provider.raw));
			return h(
				'div',
				{
					style: {
						display: 'grid',
						gap: 8,
						padding: '9px 10px 10px',
						borderRadius: 10,
						background: SOFT,
						border: `1px solid ${LINE}`,
					},
				},
				h(
					'div',
					{ style: { display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 } },
					statusDot(status.color),
					h(
						'span',
						{
							style: {
								fontSize: 11.5,
								fontWeight: 600,
								letterSpacing: '.005em',
								minWidth: 0,
								overflow: 'hidden',
								textOverflow: 'ellipsis',
								whiteSpace: 'nowrap',
							},
						},
						provider.label || provider.id || 'Provider',
					),
					h(
						'span',
						{
							style: { ...chipStyle(status.color, 0.12), marginLeft: 'auto' },
							title: provider.status ? `Status: ${provider.status}` : undefined,
						},
						status.text,
					),
				),
				...rows,
			);
		}

		function UsageWidget(props) {
			const wide =
				props && typeof props.wide === 'boolean'
					? props.wide
					: props && typeof props.collapsed === 'boolean'
						? !props.collapsed
						: false;
			const [data, setData] = React.useState(null);
			const [open, setOpen] = React.useState(false);
			const [hover, setHover] = React.useState(false);
			const [anchor, setAnchor] = React.useState({ left: 12, bottom: 44 });
			const rootRef = React.useRef(null);
			const mounted = React.useRef(false);

			const load = React.useCallback(() => {
				if (typeof window === 'undefined' || typeof window.fetch !== 'function') return;
				window
					.fetch('/plugins/harness-usage/state', { headers: { accept: 'application/json' } })
					.then((response) => (response.ok ? response.json() : null))
					.then((next) => {
						if (mounted.current && next && typeof next === 'object') setData(next);
					})
					.catch(() => {});
			}, []);

			React.useEffect(() => {
				mounted.current = true;
				load();
				const timer = window.setInterval(load, 30000);
				return () => {
					mounted.current = false;
					window.clearInterval(timer);
				};
			}, [load]);

			React.useEffect(() => {
				if (!open) return undefined;
				const onPointerDown = (event) => {
					const root = rootRef.current;
					if (root && root.contains(event.target)) return;
					setOpen(false);
				};
				const onKeyDown = (event) => {
					if (event.key === 'Escape') setOpen(false);
				};
				const onResize = () => setOpen(false);
				document.addEventListener('pointerdown', onPointerDown, true);
				document.addEventListener('keydown', onKeyDown);
				window.addEventListener('resize', onResize);
				return () => {
					document.removeEventListener('pointerdown', onPointerDown, true);
					document.removeEventListener('keydown', onKeyDown);
					window.removeEventListener('resize', onResize);
				};
			}, [open]);

			const providers =
				data && Array.isArray(data.providers)
					? data.providers.filter((provider) => provider && typeof provider === 'object')
					: [];
			const now = Date.now();
			let worst = null;
			for (const provider of providers) {
				const candidate = provider && typeof provider === 'object' ? worstOf(provider.windows) : null;
				if (candidate && (worst === null || candidate.percent > worst.percent)) worst = candidate;
			}
			const worstColor = percentColor(worst ? worst.percent : null);
			const generatedAt = data && typeof data.generatedAt === 'string' ? Date.parse(data.generatedAt) : NaN;

			const footerTitle = worst
				? `Provider usage · worst window ${worst.label} ${Math.round(worst.percent)}%${worst.resetsAt ? ` · resets ${formatAbsolute(worst.resetsAt)}` : ''}`
				: 'Provider usage';

			const toggle = (event) => {
				const rect = event.currentTarget.getBoundingClientRect();
				const viewportWidth = window.innerWidth || CARD_WIDTH + 16;
				setAnchor({
					left: Math.max(8, Math.min(rect.left, viewportWidth - CARD_WIDTH - 8)),
					bottom: Math.max(8, (window.innerHeight || 0) - rect.top + 8),
				});
				setOpen((value) => !value);
				if (!open) load();
			};

			return h(
				'div',
				{ ref: rootRef, style: { position: 'relative', display: 'flex', justifyContent: 'center' } },
				h(
					'button',
					{
						type: 'button',
						onClick: toggle,
						'aria-haspopup': 'dialog',
						'aria-expanded': open,
						'aria-label': worst
							? `Provider usage, worst window ${Math.round(worst.percent)} percent`
							: 'Provider usage, no data',
						title: footerTitle,
						onMouseEnter: () => setHover(true),
						onMouseLeave: () => setHover(false),
						onFocus: () => setHover(true),
						onBlur: () => setHover(false),
						style: {
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'center',
							gap: 6,
							height: 28,
							width: wide ? 'auto' : 28,
							padding: wide ? '0 8px' : 0,
							border: 0,
							borderRadius: 8,
							background: open || hover ? 'rgba(127,127,127,.14)' : 'transparent',
							color: 'inherit',
							fontFamily: 'inherit',
							cursor: 'pointer',
							opacity: 0.9,
							transition: 'background .12s ease',
						},
					},
					worst
						? h(Donut, {
								percent: worst.percent,
								size: 16,
								thickness: 2.5,
								color: worstColor,
								showCenter: false,
							})
						: h('span', {
								style: {
									width: 7,
									height: 7,
									borderRadius: '50%',
									background: 'rgba(139,147,167,.55)',
									flex: '0 0 auto',
								},
							}),
					wide ? h('span', { style: { fontSize: 11, letterSpacing: '.01em' } }, 'Usage') : null,
				),
				open
					? h(
							'div',
							{
								role: 'dialog',
								'aria-label': 'Provider usage',
								style: {
									position: 'fixed',
									left: anchor.left,
									bottom: anchor.bottom,
									width: `min(${CARD_WIDTH}px, calc(100vw - 16px))`,
									maxHeight: 'min(70vh, 520px)',
									overflowY: 'auto',
									overscrollBehavior: 'contain',
									padding: 12,
									borderRadius: 14,
									background: 'var(--dsh-surface-raised, #1f2430)',
									color: 'var(--dsh-text-primary, #e8eaf0)',
									border: '1px solid rgba(127,127,127,.2)',
									boxShadow: '0 18px 48px rgba(0,0,0,.35), 0 2px 8px rgba(0,0,0,.16)',
									zIndex: 2147483000,
									fontSize: 11,
									fontFamily: 'inherit',
									lineHeight: 1.35,
								},
							},
							h(
								'div',
								{ style: { display: 'flex', alignItems: 'center', gap: 8, padding: '0 1px 10px' } },
								h(
									'span',
									{ style: { fontSize: 12.5, fontWeight: 700, letterSpacing: '-.01em' } },
									'Provider usage',
								),
								h(
									'span',
									{
										style: {
											marginLeft: 'auto',
											fontSize: 9.5,
											opacity: 0.42,
											fontVariantNumeric: 'tabular-nums',
										},
									},
									Number.isFinite(generatedAt) ? formatAgo(generatedAt, now) : '',
								),
								h(
									'button',
									{
										type: 'button',
										onClick: () => setOpen(false),
										'aria-label': 'Close provider usage',
										title: 'Close',
										style: {
											display: 'inline-flex',
											alignItems: 'center',
											justifyContent: 'center',
											width: 20,
											height: 20,
											padding: 0,
											border: 0,
											borderRadius: 6,
											background: 'transparent',
											color: 'inherit',
											opacity: 0.5,
											cursor: 'pointer',
											flex: '0 0 auto',
										},
									},
									h(
										'svg',
										{ width: 10, height: 10, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
										h('path', {
											d: 'M4 4l8 8M12 4l-8 8',
											stroke: 'currentColor',
											strokeWidth: 1.6,
											strokeLinecap: 'round',
										}),
									),
								),
							),
							h(
								'div',
								{ style: { display: 'grid', gap: 8 } },
								providers.length
									? providers.map((provider, index) =>
											h(ProviderCard, {
												key: provider && provider.id ? provider.id : `provider-${index}`,
												provider,
												now,
											}),
										)
									: h(
											'p',
											{ style: { margin: 0, fontSize: 10.5, opacity: 0.6, lineHeight: 1.5 } },
											'No provider state yet.',
										),
							),
						)
					: null,
			);
		}


		function UsageSettings() {
			const [config, setConfig] = React.useState(null);
			const [state, setState] = React.useState(null);
			React.useEffect(() => {
				let alive = true;
				const load = () => {
					Promise.all([
						window.fetch('/plugins/harness-usage/config', { headers: { accept: 'application/json' } }).then((r) => (r.ok ? r.json() : null)),
						window.fetch('/plugins/harness-usage/state', { headers: { accept: 'application/json' } }).then((r) => (r.ok ? r.json() : null)),
					])
						.then(([nextConfig, nextState]) => {
							if (!alive) return;
							if (nextConfig) setConfig(nextConfig);
							if (nextState) setState(nextState);
						})
						.catch(() => {});
				};
				load();
				const timer = window.setInterval(load, 30000);
				return () => {
					alive = false;
					window.clearInterval(timer);
				};
			}, []);
			if (!config) {
				return h('section', { 'aria-label': 'Usage monitor', style: { padding: '4px 2px', fontSize: 12, opacity: 0.6 } }, 'Loading usage configuration…');
			}
			const live = new Map((state?.providers || []).map((provider) => [provider.id, provider]));
			const field = (label, value) =>
				h(
					'div',
					{ style: { display: 'grid', gridTemplateColumns: '120px 1fr', gap: 10, alignItems: 'baseline' } },
					h('span', { style: { fontSize: 11, opacity: 0.55 } }, label),
					h('span', { style: { fontSize: 11.5, overflowWrap: 'anywhere' } }, value),
				);
			return h(
				'section',
				{ 'aria-label': 'Usage monitor', style: { display: 'grid', gap: 16, padding: '4px 2px 18px', maxWidth: 680 } },
				h(
					'header',
					{ style: { display: 'grid', gap: 4 } },
					h('h2', { style: { margin: 0, fontSize: 18, fontWeight: 650 } }, 'Usage monitor'),
					h(
						'p',
						{ style: { margin: 0, fontSize: 12, lineHeight: 1.5, opacity: 0.68 } },
						'Providers, endpoints and poll cadence for the sidebar usage widget.',
					),
				),
				h(
					'div',
					{ style: { display: 'grid', gap: 1 } },
					...(config.providers || []).map((provider, index) => {
						const current = live.get(provider.id);
						const status = STATUS[current?.status] || { text: 'Not polled', color: MUTED };
						const details = provider.kind === 'claude-usage'
							? [
									field('Command', h('code', { style: { fontSize: 10.5, padding: '1px 5px', borderRadius: 4, background: 'rgba(127,127,127,.14)' } }, provider.claudeCommand || 'claude')),
									field('Source', 'local CLI; no token access'),
									field('Timeout', `${Math.round((provider.timeoutMs ?? 30000) / 1000)} s`),
								]
							: [
									field('Endpoint', provider.usageUrl || 'Not configured'),
									field(
										'API key',
										h(
											'span',
											{ style: { display: 'inline-flex', gap: 7, alignItems: 'center', flexWrap: 'wrap' } },
											h('code', { style: { fontSize: 10.5, padding: '1px 5px', borderRadius: 4, background: 'rgba(127,127,127,.14)' } }, provider.apiKeyEnv || 'none'),
											h(
												'span',
												{ style: chipStyle(provider.configured ? OK : MUTED, 0.11) },
												provider.configured ? 'Configured' : 'Missing',
											),
											provider.source && provider.source !== 'none'
												? h('span', { style: { fontSize: 10, opacity: 0.45 } }, provider.source)
												: null,
										),
									),
									field('Unit', provider.unit || '—'),
								];
						return h(
							'div',
							{
								key: provider.id || index,
								style: { display: 'grid', gap: 8, padding: '12px 0', borderTop: index === 0 ? 'none' : '1px solid rgba(127,127,127,.14)' },
							},
							h(
								'div',
								{ style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } },
								statusDot(status.color),
								h('strong', { style: { fontSize: 12.5 } }, provider.label || provider.id),
								h('span', { style: { fontSize: 10, opacity: 0.42 } }, provider.id),
								h('span', { style: { ...chipStyle(status.color, 0.11), marginLeft: 'auto' } }, status.text),
							),
							field('Adapter', provider.kind || 'http'),
							...details,
						);
					}),
				),
				h(
					'div',
					{ style: { display: 'grid', gap: 8, paddingTop: 2 } },
					field('Poll interval', `${Math.round((config.pollMs ?? 60000) / 1000)} s`),
					field('Request timeout', `${Math.round((config.timeoutMs ?? 10000) / 1000)} s`),
					field('State route', config.endpoints?.state || '/plugins/harness-usage/state'),
				),
				h(
					'p',
					{ style: { margin: 0, fontSize: 10.5, lineHeight: 1.5, opacity: 0.5 } },
					'This page mirrors the effective plugin config. Edit providers, pollMs or timeoutMs in the plugin config; the API key is stored in the credential store and never shown here.',
				),
			);
		}

		return {
			inject: ['slots'],
			apply(ctx) {
				ctx.slots.inject('sidebar.footer.action', () =>
					ctx.slots.register({ name: 'sidebar.footer.action', id: 'harness-usage', order: 20, label: 'Usage' }, UsageWidget),
				);
				ctx.slots.inject('settings.section', () =>
					ctx.slots.register({ name: 'settings.section', id: 'harness-usage', order: 16, label: () => 'Usage' }, UsageSettings),
				);
			},
		};
	},
});
