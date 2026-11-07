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
			cancelLabel: 'Cancel sign-in',
			signInCancelledLabel: 'Sign-in cancelled.',
			workingLabel: 'Waiting for browser approval\u2026',
			openTabLabel: 'Opening browser\u2026',
			pollEndedLabel: 'The sign-in attempt ended without storing a credential. Start again when ready.',
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
			// An attempt whose URL is shown is still live in the host: Sign in stays
			// disabled and the outcome poll runs until /state reports it settled.
			const [pending, setPending] = React.useState(false);
			const popupRef = React.useRef(null);
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
				popupRef.current = popup;
				try {
					const res = await fetch('/plugins/mistral-subscription/sign-in', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
					});
					const body = await res.json().catch(() => ({}));
					if (!body.started || typeof body.url !== 'string') {
						if (popup && !popup.closed) popup.close();
						setMessage({ ok: false, text: `${t('errorPrefix')}: ${body.error || res.status}` });
						return;
					}
					setAuthorizeUrl(body.url);
					// The URL is up, but the key is not stored yet: keep the attempt
					// marked as in flight so Cancel is offered and the poll runs.
					setPending(true);
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
					// busy clears; pending does NOT — the attempt stays live past
					// this response, and the poll below settles it.
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
					await fetch('/plugins/mistral-subscription/sign-out', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
					});
					setMessage({ ok: true, text: 'Signed out. The stored credential was deleted.' });
				} catch (error) {
					setMessage({ ok: false, text: String((error && error.message) || error) });
				} finally {
					setBusy(false);
					void refresh();
				}
			}, [refresh]);

			const cancelSignIn = React.useCallback(async () => {
				const popup = popupRef.current;
				popupRef.current = null;
				try {
					const res = await fetch('/plugins/mistral-subscription/cancel', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
					});
					const body = await res.json().catch(() => ({}));
					if (body.cancelled !== true) {
						if (res.status !== 200 || body.error) {
							setMessage({ ok: false, text: `${t('errorPrefix')}: ${body.error || res.status}` });
							return;
						}
						setMessage({ ok: true, text: t('pollEndedLabel') });
						return;
					}
					if (popup && !popup.closed) popup.close();
					setMessage({ ok: true, text: t('signInCancelledLabel') });
				} catch (error) {
					setMessage({ ok: false, text: String((error && error.message) || error) });
				} finally {
					setPending(false);
					setBusy(false);
					void refresh();
				}
			}, [refresh, t]);

			const pollOutcome = React.useCallback(async () => {
				// After the tab navigates away, the attempt settles in the host.
				// Poll /state until it no longer reports inFlight, then render how
				// the attempt ended (stored credential, or error/outcome code).
				try {
					const res = await fetch('/plugins/mistral-subscription/state', { headers: { accept: 'application/json' } });
					if (!res.ok) return;
					const body = await res.json();
					setState({ loading: false, configured: body.configured === true, inFlight: body.inFlight === true });
					if (body.configured === true) {
						setMessage({ ok: true, text: 'Signed in. Mistral requests now bill to the subscription.' });
						setAuthorizeUrl(null);
						setPending(false);
						return;
					}
					if (body.inFlight !== true) {
						// The attempt ended with nothing stored: show the outcome the
						// host reported (fixed code only — never token material).
						setMessage(
							body.error || body.outcome
								? { ok: false, text: `${t('errorPrefix')}: ${body.error || body.outcome}` }
								: { ok: true, text: t('pollEndedLabel') },
						);
						setAuthorizeUrl(null);
						setPending(false);
					}
				} catch {}
			}, [t]);

			React.useEffect(() => {
				// Runs while the attempt is pending, NOT while busy: busy clears as
				// soon as the sign-in response answers, the attempt stays in flight.
				if (!pending) return;
				const id = setInterval(() => void pollOutcome(), 2000);
				void pollOutcome();
				const stop = setTimeout(() => setPending(false), 180000);
				return () => {
					clearInterval(id);
					clearTimeout(stop);
				};
			}, [pending, pollOutcome]);
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
					(state.inFlight || pending) &&
						h(
							'button',
							{ style: buttonStyle, ariaLabel: t('cancelLabel'), onClick: () => void cancelSignIn() },
							t('cancelLabel'),
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
