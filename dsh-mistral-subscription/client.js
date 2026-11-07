window.__ModuleLoader__.load({
	id: '@pi-harness/dsh-plugin-mistral-subscription',
	factory(require) {
		const React = require('react');
		const h = React.createElement;

		const NS = 'mistral-subscription';

		const en = {
			title: 'Mistral Subscription',
			subtitle: 'Sign in through console.mistral.ai so Mistral requests bill to the plan\u2019s Vibe Code quota instead of pay-as-you-go API credits.',
			stateLabel: 'Credential',
			signedIn: 'Stored \u2014 Mistral requests use the subscription.',
			signedOut: 'Not stored \u2014 requests on this route fail until you sign in.',
			checkingLabel: 'Checking\u2026',
			signInLabel: 'Sign in with console.mistral.ai',
			signOutLabel: 'Sign out',
			workingLabel: 'Waiting for browser approval\u2026',
			openTabLabel: 'Opening browser\u2026',
			copyLinkLabel: 'Copy sign-in link',
			copiedLinkLabel: 'Link copied \u2014 paste it in your browser',
			copyFailedLabel: 'Copy failed \u2014 open this URL manually:',
			popupBlockedLabel: 'Pop-up blocked \u2014 use the copy link below.',
			footnote: 'The key is stored in the dsh credential store under llm-pi-ai/mistral-subscription and is never displayed here.',
			errorPrefix: 'Sign-in failed',
		};

		function Card({ t }) {
			const [state, setState] = React.useState({ loading: true, configured: false, inFlight: false });
			const [busy, setBusy] = React.useState(false);
			const [message, setMessage] = React.useState(null);
			const [authorizeUrl, setAuthorizeUrl] = React.useState(null);
			const [copyState, setCopyState] = React.useState(null);

			const refresh = React.useCallback(async () => {
				try {
					const res = await fetch('/plugins/mistral-subscription/state', { headers: { accept: 'application/json' } });
					if (!res.ok) throw new Error(String(res.status));
					const body = await res.json();
					setState({ loading: false, configured: body.configured === true, inFlight: body.inFlight === true });
				} catch {
					setState({ loading: false, configured: false, inFlight: false });
				}
			}, []);

			React.useEffect(() => {
				void refresh();
			}, [refresh]);

			const signIn = React.useCallback(async () => {
				setBusy(true);
				setMessage(null);
				setCopyState(null);
				// Pre-open the tab inside the click handler: a popup opened during a
				// user gesture is allowed, one opened after an await usually is not.
				// Mirrors the shipped account sign-in dialog.
				const popup = window.open('about:blank', '_blank');
				if (popup) popup.opener = null;
				try {
					const res = await fetch('/plugins/mistral-subscription/sign-in', { method: 'POST' });
					const body = await res.json().catch(() => ({}));
					if (!body.started || typeof body.url !== 'string') {
						if (popup && !popup.closed) popup.close();
						setMessage({ ok: false, text: `${t('errorPrefix')}: ${body.error || res.status}` });
						return;
					}
					setAuthorizeUrl(body.url);
					if (popup && !popup.closed) {
						popup.location.replace(body.url);
						setMessage({ ok: true, text: t('openTabLabel') });
					} else {
						setCopyState({ url: body.url });
						setMessage({ ok: false, text: t('popupBlockedLabel') });
					}
				} catch (error) {
					if (popup && !popup.closed) popup.close();
					setMessage({ ok: false, text: `${t('errorPrefix')}: ${String((error && error.message) || error)}` });
				} finally {
					setBusy(false);
					void refresh();
				}
			}, [refresh, t]);

			const copyLink = React.useCallback(async (url) => {
				try {
					await navigator.clipboard.writeText(url);
					setMessage({ ok: true, text: t('copiedLinkLabel') });
				} catch {
					setMessage({ ok: false, text: t('copyFailedLabel') });
				}
			}, [t]);

			const signOut = React.useCallback(async () => {
				setBusy(true);
				setMessage(null);
				setCopyState(null);
				try {
					await fetch('/plugins/mistral-subscription/sign-out', { method: 'POST' });
					setMessage({ ok: true, text: 'Signed out. The stored credential was deleted.' });
				} catch (error) {
					setMessage({ ok: false, text: String((error && error.message) || error) });
				} finally {
					setBusy(false);
					void refresh();
				}
			}, [refresh]);

			const pollOutcome = React.useCallback(async () => {
				// After the tab navigates away, the attempt settles in the host.
				// Poll /state briefly so the card flips to Signed in when it does.
				try {
					const res = await fetch('/plugins/mistral-subscription/state', { headers: { accept: 'application/json' } });
					if (!res.ok) return;
					const body = await res.json();
					setState({ loading: false, configured: body.configured === true, inFlight: body.inFlight === true });
					if (body.configured === true) {
						setMessage({ ok: true, text: 'Signed in. Mistral requests now bill to the subscription.' });
						setAuthorizeUrl(null);
					}
				} catch {}
			}, []);

			React.useEffect(() => {
				if (!busy || !message || message.text !== t('openTabLabel')) return;
				const id = setInterval(() => void pollOutcome(), 2000);
				const stop = setTimeout(() => clearInterval(id), 180000);
				return () => {
					clearInterval(id);
					clearTimeout(stop);
				};
			}, [busy, message, pollOutcome, t]);
  			const buttonStyle = {
				fontSize: 12,
				padding: '6px 12px',
				borderRadius: 8,
				border: '1px solid rgba(127,127,127,.3)',
				cursor: busy ? 'wait' : 'pointer',
			};

			return h(
				'section',
				{ 'aria-label': t('title'), style: { display: 'grid', gap: 12, padding: '4px 2px 18px', maxWidth: 640 } },
				h(
					'header',
					{ style: { display: 'grid', gap: 4 } },
					h('h2', { style: { margin: 0, fontSize: 18, fontWeight: 650 } }, t('title')),
					h('p', { style: { margin: 0, fontSize: 12, lineHeight: 1.5, opacity: 0.68 } }, t('subtitle')),
				),
				h(
					'div',
					{ style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, flexWrap: 'wrap' } },
					h('span', { style: { opacity: 0.55 } }, `${t('stateLabel')}:`),
					h(
						'span',
						{ style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
						h('span', {
							style: {
								width: 7,
								height: 7,
								borderRadius: '50%',
								background: state.loading ? 'rgba(127,127,127,.5)' : state.configured ? 'rgba(80,180,110,.9)' : 'rgba(200,120,60,.9)',
								flex: '0 0 auto',
							},
						}),
						h('span', null, state.loading ? t('checkingLabel') : state.configured ? t('signedIn') : t('signedOut')),
					),
				),
				h(
					'div',
					{ style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
					!state.configured &&
						h(
							'button',
							{ style: buttonStyle, disabled: busy || state.inFlight, onClick: signIn },
							busy ? t('workingLabel') : t('signInLabel'),
						),
					state.configured &&
						h(
							'button',
							{ style: buttonStyle, disabled: busy, onClick: signOut },
							t('signOutLabel'),
						),
				),
				authorizeUrl &&
					h(
						'div',
						{ style: { display: 'grid', gap: 6, fontSize: 12 } },
						h(
							'div',
							{ style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
							h(
								'button',
								{ style: buttonStyle, onClick: () => void copyLink(authorizeUrl) },
								t('copyLinkLabel'),
							),
						),
						h(
							'code',
							{
								style: {
									fontSize: 11,
									padding: '4px 6px',
									borderRadius: 6,
									background: 'rgba(127,127,127,.12)',
									wordBreak: 'break-all',
									display: 'block',
								},
							},
							authorizeUrl,
						),
					),
				copyState &&
					h(
						'div',
						{ style: { display: 'grid', gap: 6, fontSize: 12 } },
						h(
							'button',
							{ style: buttonStyle, onClick: () => void copyLink(copyState.url) },
							t('copyLinkLabel'),
						),
						h(
							'code',
							{
								style: {
									fontSize: 11,
									padding: '4px 6px',
									borderRadius: 6,
									background: 'rgba(127,127,127,.12)',
									wordBreak: 'break-all',
									display: 'block',
								},
							},
							copyState.url,
						),
					),
				message &&
					h(
						'div',
						{
							role: 'status',
							style: {
								fontSize: 12,
								lineHeight: 1.5,
								padding: '8px 10px',
								borderRadius: 8,
								border: `1px solid ${message.ok ? 'rgba(80,180,110,.4)' : 'rgba(200,120,60,.4)'}`,
								background: message.ok ? 'rgba(80,180,110,.08)' : 'rgba(200,120,60,.08)',
							},
						},
						message.text,
					),
				h('p', { style: { margin: 0, fontSize: 10.5, lineHeight: 1.45, opacity: 0.5 } }, t('footnote')),
			);
		}

		return {
			inject: ['slots', 'locale'],
			apply(ctx) {
				const t = ctx.locale.bind(NS);
				ctx.effect(() => ctx.locale.register(NS, 'en', en), 'mistral-subscription: copy');
				ctx.slots.inject('settings.section', () =>
					ctx.slots.register(
						{
							name: 'settings.section',
							id: 'mistral-subscription',
							order: 16,
							label: () => t('title'),
							locale: NS,
							inject: () => ({ t }),
						},
						Card,
					),
				);
			},
		};
	},
});
