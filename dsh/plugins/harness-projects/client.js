window.__ModuleLoader__.load({
	id: '@pi-harness/dsh-plugin-harness-projects',
	factory(require) {
		const React = require('react');
		const h = React.createElement;
		const NS = 'harness-projects';
		const PANEL_ID = 'git-projects';
		const STATE_URL = '/plugins/harness-projects/state';
		const ACTION_URL = '/plugins/harness-projects/action';

		const en = {
			panel: 'Projects',
			title: 'Git Projects',
			subtitle: 'Local repositories as projects, each starting its sessions with warm agent-vault context.',
			refresh: 'Refresh',
			add: 'Add',
			addLabel: 'Repository path',
			addPlaceholder: '/absolute/path/to/repo',
			registry: 'Registry',
			empty: 'No projects yet.',
			emptyHint: 'Add a repository above, or open a session inside one and it registers itself.',
			select: 'Select a project to see its git state and warm context.',
			warm: 'Warm context',
			warmEmpty: 'Nothing warm yet: this repository has no project note, findings, runs or log lines in the vault.',
			forget: 'Forget',
			pin: 'Pin',
			unpin: 'Unpin',
			commits: 'Recent commits',
			loading: 'Loading projects…',
			error: 'Could not read state',
			retry: 'Try again',
			detached: 'detached HEAD',
			clean: 'clean',
			modified: 'modified',
			untracked: 'untracked',
			unmerged: 'conflicts',
			ahead: 'ahead',
			behind: 'behind',
			uptodate: 'up to date',
			vault: 'Agent vault',
			vaultMissing: 'Agent vault not resolved. Run vault.mjs setup, or set skillRoot.',
			vaultUnavailable: 'Vault unreachable',
			pull: 'Pull',
			push: 'Push',
			pulling: 'Pulling…',
			pushing: 'Pushing…',
			pending: 'uncommitted',
			synced: 'in sync',
			localOnly: 'no remote',
			modeNone: 'off',
			pinned: 'Pinned',
			busy: 'Working…',
			notRepo: 'not a git repository',
			dismiss: 'Dismiss',
			status: 'Status',
			repository: 'Repository',
			sync: 'Sync',
			workingTree: 'Working tree',
			tips: 'Tips',
			tipsTitle: 'How projects work',
			tipsSub: 'Five things that make this panel do more than list folders.',
			tipsDismiss: "Don't show this again",
			tipsClose: 'Got it',
			tipsOpen: 'Tips',
		};

		/* One dialog of short, concrete orientation copy. Each tip is a thing the
		   panel can actually do, so the dialog never promises a missing feature. */
		const TIPS = [
			{
				title: 'A project is just a local repository',
				body: 'Point the panel at any folder inside a git work tree. You do not register projects by hand if you use sessions: opening a session inside a repo registers it automatically, which is why the list often fills itself.',
			},
			{
				title: 'Warm context is why this exists',
				body: 'Select a project and the right pane shows the context its sessions start with: project note, open findings, recent runs and the newest log lines from the agent vault. More warm context means less re-explaining, so keep vault notes current.',
			},
			{
				title: 'The vault is separate from your repos',
				body: 'The strip at the top is the agent vault itself, not a project. Pull brings vault notes down, Push commits and sends yours up. The vault is the only thing here that syncs to a remote, so a project showing commits ahead is normal.',
			},
			{
				title: 'Vault mode decides how much is read',
				body: 'Each project carries a vault mode. <code>full</code> loads the complete warm block, <code>meta</code> loads identifiers and links only, and <code>off</code> opts the repo out entirely. Use <code>off</code> for scratch repos you do not want in your notes.',
			},
			{
				title: 'Pin what you open daily',
				body: 'Pinning keeps a project at the top of the list. Refresh re-reads git and vault state; the panel also polls on its own, so you rarely need it. Forget removes a project from the list without touching the repository on disk.',
			},
		];

		/* Pseudo-classes, selection and scrollbar styling need real CSS, so the
		   sheet goes through the package-scoped `styles` builtin where the runtime
		   exposes it, with a plain <style> tag as the fallback. */
		const CSS = `
.hp-root{height:100%;overflow:auto;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}
.hp-root ::selection{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 28%,transparent);color:var(--dsw-alias-label-primary)}
.hp-inner{max-width:1080px;margin:0 auto;padding:28px 28px 56px;display:grid;gap:20px}
.hp-num{font-variant-numeric:tabular-nums}
.hp-mono{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;font-variant-ligatures:none}

.hp-head{display:flex;align-items:flex-start;gap:16px}
.hp-title{margin:0;font-size:19px;font-weight:650;letter-spacing:-0.015em;line-height:1.25}
.hp-sub{margin:5px 0 0;font-size:12.5px;color:var(--dsw-alias-label-secondary);max-width:62ch;text-wrap:pretty}

.hp-btn{font:inherit;font-size:12px;font-weight:500;line-height:1;padding:7px 11px;border-radius:7px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);
  cursor:pointer;transition:background 140ms ease,border-color 140ms ease,color 140ms ease;white-space:nowrap}
.hp-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}
.hp-btn:active:not(:disabled){transform:translateY(0.5px)}
.hp-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.hp-btn:disabled{opacity:.45;cursor:not-allowed}
/* The brand token flips from near-black (light) to near-white (dark), so the
   label cannot be a fixed white: it is mixed against the surface it sits on. */
.hp-btn-primary{background:var(--dsw-alias-brand-primary);border-color:transparent;
  color:color-mix(in srgb,var(--dsw-alias-bg-base) 94%,var(--dsw-alias-brand-primary))}
.hp-btn-primary:hover:not(:disabled){filter:brightness(1.08);border-color:transparent;background:var(--dsw-alias-brand-primary)}
.hp-btn-quiet{background:transparent;border-color:transparent;color:var(--dsw-alias-label-secondary)}
.hp-btn-quiet:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-color:transparent}
.hp-btn-sm{padding:5px 9px;font-size:11.5px}

.hp-vault{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 14px;border-radius:10px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.hp-vault-bad{flex-wrap:wrap;gap:8px;padding:11px 14px;border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 38%,var(--dsw-alias-border-l1));
  background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 7%,var(--dsw-alias-bg-layer-1));
  color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 42%,var(--dsw-alias-label-primary))}
.hp-vault-name{display:flex;align-items:center;gap:7px;font-weight:600;font-size:12.5px}
.hp-vault-meta{display:flex;align-items:center;gap:9px;flex-wrap:wrap;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.hp-dot{width:6px;height:6px;border-radius:50%;flex:none;background:var(--dsw-alias-state-idle-primary)}
.hp-dot-ok{background:var(--dsw-alias-state-success-primary)}
.hp-dot-warn{background:var(--dsw-alias-state-warn-primary)}
/* Separators are punctuation, not chrome: they take the same ink as the text
   they divide so they never read as a broken border token. */
.hp-sep{color:var(--dsw-alias-label-secondary);user-select:none}

.hp-add{display:flex;gap:8px;align-items:center}
.hp-input{flex:1 1 auto;min-width:0;font:inherit;font-size:12.5px;padding:8px 11px;border-radius:8px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);
  transition:border-color 140ms ease,background 140ms ease}
.hp-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.hp-input:hover{border-color:var(--dsw-alias-border-l2)}
.hp-input:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 20%,transparent)}

.hp-split{display:grid;grid-template-columns:minmax(230px,300px) minmax(0,1fr);gap:18px;align-items:start}
@media (max-width:860px){.hp-split{grid-template-columns:minmax(0,1fr)}}

.hp-list{display:grid;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.hp-row{display:grid;gap:5px;width:100%;text-align:left;font:inherit;padding:10px 12px;cursor:pointer;
  border:0;border-bottom:1px solid var(--dsw-alias-border-l1);background:transparent;color:inherit;
  transition:background 140ms ease;position:relative}
.hp-row:last-child{border-bottom:0}
.hp-row:hover{background:var(--dsw-alias-bg-layer-2)}
.hp-row:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.hp-row[aria-pressed="true"]{background:var(--dsw-alias-bg-layer-2)}
.hp-row[aria-pressed="true"]::before{content:"";position:absolute;left:0;top:0;bottom:0;width:2px;background:var(--dsw-alias-brand-primary)}
.hp-row-top{display:flex;align-items:center;gap:8px;min-width:0}
.hp-row-name{font-weight:600;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1}
.hp-pin{flex:none;color:var(--dsw-alias-brand-primary);display:inline-flex;align-items:center}
.hp-row-path{font-size:10.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hp-row-meta{display:flex;align-items:center;gap:7px;flex-wrap:wrap;font-size:10.5px;color:var(--dsw-alias-label-secondary)}

.hp-chip{display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:550;line-height:1;
  padding:3px 6px;border-radius:5px;border:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);white-space:nowrap}
/* Chip text must stay readable on its own tint. The raw state colors are tuned
   as accents rather than as type, so each is mixed toward the theme's label ink:
   that darkens on light and lightens on dark, and both clear 4.5:1. */
.hp-chip-ok{color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,var(--dsw-alias-label-primary));
  border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 32%,var(--dsw-alias-border-l1));
  background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent)}
.hp-chip-warn{color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 45%,var(--dsw-alias-label-primary));
  border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 32%,var(--dsw-alias-border-l1));
  background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,transparent)}
.hp-chip-mute{color:var(--dsw-alias-label-secondary)}

.hp-detail{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.hp-detail-head{display:flex;align-items:flex-start;gap:12px;padding:14px 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.hp-detail-name{font-size:14.5px;font-weight:650;letter-spacing:-0.01em;margin:0;min-width:0;overflow-wrap:anywhere}
.hp-detail-path{margin:3px 0 0;font-size:10.5px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.hp-body{display:grid}
.hp-block{display:grid;gap:9px;padding:13px 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.hp-block:last-child{border-bottom:0}
.hp-block-label{margin:0;font-size:10.5px;font-weight:600;letter-spacing:0.045em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}

.hp-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(112px,1fr));gap:10px 16px}
.hp-fact{display:grid;gap:2px;min-width:0}
.hp-fact-k{font-size:10px;color:var(--dsw-alias-label-secondary);letter-spacing:0.02em}
.hp-fact-v{font-size:12px;font-weight:550;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

.hp-commits{display:grid;gap:7px;margin:0;padding:0;list-style:none}
.hp-commit{display:grid;grid-template-columns:auto minmax(0,1fr);gap:9px;align-items:baseline;font-size:11.5px}
.hp-commit-hash{font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.hp-commit-txt{min-width:0}
.hp-commit-subj{color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hp-commit-by{font-size:10px;color:var(--dsw-alias-label-secondary)}

.hp-warm{margin:0;padding:11px 13px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-2);font-size:11.5px;line-height:1.6;white-space:pre-wrap;overflow-wrap:break-word;
  max-height:340px;overflow:auto;color:var(--dsw-alias-label-secondary);scrollbar-width:thin}
.hp-warm::-webkit-scrollbar{width:9px;height:9px}
.hp-warm::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2);border-radius:99px;border:2px solid transparent;background-clip:content-box}
.hp-warm::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-label-tertiary);background-clip:content-box}
.hp-warm::-webkit-scrollbar-track{background:transparent}

.hp-note{display:grid;gap:8px;justify-items:start;padding:16px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.hp-note-strong{margin:0;font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary)}
.hp-err{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 13px;border-radius:9px;font-size:12px;
  border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 38%,var(--dsw-alias-border-l1));
  background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 7%,var(--dsw-alias-bg-layer-1));
  color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 42%,var(--dsw-alias-label-primary))}
.hp-skel{display:grid;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}
.hp-skel-row{height:56px;background:linear-gradient(90deg,var(--dsw-alias-bg-layer-1) 0%,var(--dsw-alias-bg-layer-2) 50%,var(--dsw-alias-bg-layer-1) 100%);
  background-size:200% 100%;animation:hp-shimmer 1.4s ease-in-out infinite;border-bottom:1px solid var(--dsw-alias-border-l1)}
.hp-skel-row:last-child{border-bottom:0}
@keyframes hp-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
.hp-foot{font-size:10.5px;color:var(--dsw-alias-label-secondary);display:flex;gap:6px;align-items:center;flex-wrap:wrap}

/* tips dialog */
.hp-scrim{position:fixed;inset:0;z-index:60;display:grid;place-items:center;padding:24px;
  background:color-mix(in srgb,var(--dsw-alias-bg-base) 62%,transparent);
  -webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);animation:hp-fade 160ms ease}
@keyframes hp-fade{from{opacity:0}to{opacity:1}}
@keyframes hp-rise{from{opacity:0;transform:translateY(6px) scale(.985)}to{opacity:1;transform:none}}
.hp-dialog{width:min(560px,100%);max-height:min(78vh,620px);display:flex;flex-direction:column;
  border-radius:14px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);
  box-shadow:0 18px 48px -12px rgba(0,0,0,.42),0 2px 8px -2px rgba(0,0,0,.2);animation:hp-rise 180ms ease;overflow:hidden}
.hp-dialog:focus{outline:none}
.hp-dialog-head{display:flex;align-items:flex-start;gap:12px;padding:16px 18px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.hp-dialog-title{margin:0;font-size:14.5px;font-weight:650;letter-spacing:-0.01em}
.hp-dialog-sub{margin:4px 0 0;font-size:12px;color:var(--dsw-alias-label-secondary);max-width:46ch;text-wrap:pretty}
.hp-x{flex:none;width:26px;height:26px;display:grid;place-items:center;border-radius:6px;cursor:pointer;
  border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);
  transition:background 140ms ease,color 140ms ease}
.hp-x:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.hp-x:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.hp-dialog-body{overflow:auto;padding:6px 18px 14px;scrollbar-width:thin}
.hp-dialog-body::-webkit-scrollbar{width:9px}
.hp-dialog-body::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2);border-radius:99px;border:2px solid transparent;background-clip:content-box}
.hp-tip{display:grid;grid-template-columns:auto minmax(0,1fr);gap:11px;padding:11px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.hp-tip:last-child{border-bottom:0}
/* The numeral is text a reader must actually read, so it uses label ink rather
   than a brand mix: the brand token inverts between themes and would vanish. */
.hp-tip-n{flex:none;width:19px;height:19px;display:grid;place-items:center;border-radius:50%;
  font-size:10.5px;font-weight:650;font-variant-numeric:tabular-nums;
  border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 26%,var(--dsw-alias-border-l1));
  background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-primary)}
.hp-tip-t{margin:0 0 2px;font-size:12.5px;font-weight:600;line-height:1.35}
.hp-tip-d{margin:0;font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-secondary);text-wrap:pretty}
.hp-tip-d code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;
  padding:1px 4px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);
  color:var(--dsw-alias-label-primary);white-space:nowrap}
.hp-dialog-foot{display:flex;align-items:center;gap:10px;padding:11px 18px;border-top:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-1)}
.hp-check{display:flex;align-items:center;gap:7px;font-size:11.5px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.hp-check input{width:13px;height:13px;accent-color:var(--dsw-alias-brand-primary);cursor:pointer;margin:0}
.hp-check input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
@media (max-width:520px){
  .hp-dialog{max-height:86vh}
  .hp-dialog-head,.hp-dialog-body,.hp-dialog-foot{padding-left:14px;padding-right:14px}
}

@media (prefers-reduced-motion:reduce){
  .hp-skel-row{animation:none}
  .hp-scrim,.hp-dialog{animation:none}
  .hp-btn,.hp-row,.hp-input{transition:none}
}
`;

		function installCss() {
			try {
				if (typeof styles !== 'undefined' && styles && typeof styles.insert === 'function') return styles.insert(CSS);
			} catch {
				// Fall through to the style tag below.
			}
			const tag = document.createElement('style');
			tag.dataset.hp = NS;
			tag.textContent = CSS;
			document.head.append(tag);
			return () => tag.remove();
		}

		const cls = (...names) => names.filter(Boolean).join(' ');

		/* Drawn icons in one stroke weight; no glyphs or emoji. */
		const PinIcon = () =>
			h(
				'svg',
				{ width: 11, height: 11, viewBox: '0 0 16 16', 'aria-hidden': true, focusable: 'false' },
				h('path', {
					d: 'M9.6 2.3 13.7 6.4l-1.6.5-2.3 2.3.2 2.5-1.3 1.3-2.2-2.2-2.9 2.9-.9-.9 2.9-2.9L3.4 7.7 4.7 6.4l2.5.2 2.3-2.3z',
					fill: 'currentColor',
				}),
			);

		const VaultIcon = () =>
			h(
				'svg',
				{ width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, focusable: 'false' },
				h('path', {
					d: 'M2.4 4.6a1 1 0 0 1 1-1h2.9l1.2 1.5h4.1a1 1 0 0 1 1 1v5.3a1 1 0 0 1-1 1H3.4a1 1 0 0 1-1-1z',
					stroke: 'currentColor',
					strokeWidth: 1.3,
					strokeLinejoin: 'round',
				}),
			);

		const MODE_TONE = { full: 'hp-chip-ok', meta: 'hp-chip-warn', none: 'hp-chip-mute' };

		function dirtChips(git) {
			if (!git) return [];
			const out = [];
			if (git.unmerged) out.push({ label: `${git.unmerged} ${en.unmerged}`, tone: 'hp-chip-warn' });
			if (git.dirty) out.push({ label: `${git.dirty} ${en.modified}`, tone: 'hp-chip-warn' });
			if (git.untracked) out.push({ label: `${git.untracked} ${en.untracked}`, tone: 'hp-chip-mute' });
			if (!out.length) out.push({ label: en.clean, tone: 'hp-chip-ok' });
			return out;
		}

		function driftText(git) {
			if (!git || !git.upstream) return null;
			if (git.ahead > 0 || git.behind > 0) {
				return [git.ahead > 0 ? `${git.ahead} ${en.ahead}` : '', git.behind > 0 ? `${git.behind} ${en.behind}` : ''].filter(Boolean).join(', ');
			}
			return en.uptodate;
		}

		function VaultStrip({ vault, vaultReady, busy, onSync }) {
			/* Both "no vault resolved" and "vault probe failed" leave the panel
			   without sync controls, so they share one loud surface. */
			if (vaultReady === false || !vault || vault.ok === false) {
				const reason = vaultReady === false ? en.vaultMissing : `${en.vaultUnavailable}: ${(vault && vault.reason) || 'unknown'}`;
				return h(
					'div',
					{ className: 'hp-vault hp-vault-bad', role: 'status' },
					h('span', { className: 'hp-vault-name' }, h(VaultIcon, null), en.vault),
					h('span', null, reason),
				);
			}

			const tone = vault.state === 'synced' ? 'hp-dot-ok' : vault.state === 'pending' || vault.state === 'behind' ? 'hp-dot-warn' : 'hp-dot';
			const drift =
				vault.state === 'pending'
					? `${vault.dirty} ${en.pending}`
					: vault.state === 'behind'
						? `${vault.behind} ${en.behind}`
						: vault.state === 'local'
							? en.localOnly
							: en.synced;

			return h(
				'div',
				{ className: 'hp-vault', role: 'status' },
				h('span', { className: 'hp-vault-name' }, h('span', { className: cls('hp-dot', tone) }), h('span', { className: 'hp-mono' }, vault.name)),
				h(
					'span',
					{ className: 'hp-vault-meta hp-num' },
					vault.branch ? h('span', { className: 'hp-mono' }, vault.branch) : null,
					vault.branch ? h('span', { className: 'hp-sep' }, '·') : null,
					h('span', null, drift),
					vault.ahead > 0 ? h('span', { className: 'hp-chip hp-chip-warn' }, `${vault.ahead} ${en.ahead}`) : null,
					vault.lastCommit && vault.lastCommit.when
						? h('span', { className: 'hp-sep' }, '·')
						: null,
					vault.lastCommit && vault.lastCommit.when
						? h('span', { title: vault.lastCommit.subject }, `last commit ${vault.lastCommit.when}`)
						: null,
				),
				h('span', { style: { flex: 1 } }),
				h(
					'span',
					{ style: { display: 'flex', gap: '6px' } },
					h('button', { className: 'hp-btn hp-btn-sm', disabled: Boolean(busy), onClick: () => onSync('pull') }, busy === 'pull' ? en.pulling : en.pull),
					h('button', { className: 'hp-btn hp-btn-sm', disabled: Boolean(busy), onClick: () => onSync('push') }, busy === 'push' ? en.pushing : en.push),
				),
			);
		}

		/* Remembering the dismissal is a convenience, never a requirement: a browser
		   that refuses storage just shows the dialog again on the next visit. */
		const TIPS_KEY = 'harness-projects:tips-dismissed';
		function readTipsDismissed() {
			try {
				return window.localStorage.getItem(TIPS_KEY) === '1';
			} catch {
				return false;
			}
		}
		function writeTipsDismissed() {
			try {
				window.localStorage.setItem(TIPS_KEY, '1');
			} catch {
				/* Storage unavailable; the dialog simply returns next session. */
			}
		}

		function TipsDialog({ onClose }) {
			const [dontShow, setDontShow] = React.useState(false);
			const dialogRef = React.useRef(null);
			const closeRef = React.useRef(null);

			const close = React.useCallback(() => {
				if (dontShow) writeTipsDismissed();
				onClose();
			}, [dontShow, onClose]);

			React.useEffect(() => {
				const previous = document.activeElement;
				closeRef.current?.focus();

				const onKeyDown = (event) => {
					if (event.key === 'Escape') {
						event.stopPropagation();
						close();
						return;
					}
					if (event.key !== 'Tab') return;
					// Keep Tab inside the dialog rather than the panel behind it.
					const focusable = dialogRef.current?.querySelectorAll('button, [href], input, [tabindex]:not([tabindex="-1"])');
					if (!focusable || focusable.length === 0) return;
					const first = focusable[0];
					const last = focusable[focusable.length - 1];
					if (event.shiftKey && document.activeElement === first) {
						event.preventDefault();
						last.focus();
					} else if (!event.shiftKey && document.activeElement === last) {
						event.preventDefault();
						first.focus();
					}
				};

				document.addEventListener('keydown', onKeyDown, true);
				return () => {
					document.removeEventListener('keydown', onKeyDown, true);
					if (previous && typeof previous.focus === 'function') previous.focus();
				};
			}, [close]);

			return h(
				'div',
				{
					className: 'hp-scrim',
					onMouseDown: (event) => {
						if (event.target === event.currentTarget) close();
					},
				},
				h(
					'div',
					{
						className: 'hp-dialog',
						role: 'dialog',
						'aria-modal': 'true',
						'aria-labelledby': 'hp-tips-title',
						'aria-describedby': 'hp-tips-sub',
						tabIndex: -1,
						ref: dialogRef,
					},
					h(
						'div',
						{ className: 'hp-dialog-head' },
						h(
							'div',
							{ style: { flex: 1, minWidth: 0 } },
							h('h2', { className: 'hp-dialog-title', id: 'hp-tips-title' }, en.tipsTitle),
							h('p', { className: 'hp-dialog-sub', id: 'hp-tips-sub' }, en.tipsSub),
						),
						h(
							'button',
							{ className: 'hp-x', onClick: close, 'aria-label': en.dismiss, ref: closeRef },
							h(
								'svg',
								{ width: 13, height: 13, viewBox: '0 0 16 16', 'aria-hidden': true, focusable: 'false' },
								h('path', { d: 'M4 4l8 8M12 4l-8 8', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
							),
						),
					),
					h(
						'div',
						{ className: 'hp-dialog-body' },
						TIPS.map((tip, index) =>
							h(
								'div',
								{ className: 'hp-tip', key: tip.title },
								h('span', { className: 'hp-tip-n', 'aria-hidden': true }, String(index + 1)),
								h(
									'div',
									null,
									h('p', { className: 'hp-tip-t' }, tip.title),
									h('p', { className: 'hp-tip-d' }, renderRichText(tip.body)),
								),
							),
						),
					),
					h(
						'div',
						{ className: 'hp-dialog-foot' },
						h(
							'label',
							{ className: 'hp-check' },
							h('input', { type: 'checkbox', checked: dontShow, onChange: (event) => setDontShow(event.target.checked) }),
							en.tipsDismiss,
						),
						h('span', { style: { flex: 1 } }),
						h('button', { className: 'hp-btn hp-btn-primary', onClick: close }, en.tipsClose),
					),
				),
			);
		}

		/* Tip copy is authored with <code> spans for the few literal values worth
		   setting apart. Rendering them as nodes keeps the copy readable in source
		   without handing raw HTML to the DOM. */
		function renderRichText(text) {
			const out = [];
			const pattern = /<code>([\s\S]*?)<\/code>/g;
			let cursor = 0;
			let match;
			let key = 0;
			while ((match = pattern.exec(text)) !== null) {
				if (match.index > cursor) out.push(text.slice(cursor, match.index));
				out.push(h('code', { key: `c${key++}` }, match[1]));
				cursor = match.index + match[0].length;
			}
			if (cursor < text.length) out.push(text.slice(cursor));
			return out;
		}

		function ProjectsPanel() {
			const [state, setState] = React.useState(null);
			const [detail, setDetail] = React.useState(null);
			const [selected, setSelected] = React.useState(null);
			const [error, setError] = React.useState(null);
			const [busy, setBusy] = React.useState(null);
			const [draft, setDraft] = React.useState('');
			const [tipsOpen, setTipsOpen] = React.useState(false);
			const mounted = React.useRef(false);

			const get = React.useCallback(
				(url) =>
					window
						.fetch(url, { headers: { accept: 'application/json' } })
						.then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)))),
				[],
			);

			const load = React.useCallback(() => {
				if (typeof window === 'undefined' || typeof window.fetch !== 'function') return Promise.resolve();
				return get(STATE_URL)
					.then((next) => {
						if (!mounted.current) return;
						setState(next);
						setError(null);
						setSelected((current) => current ?? (Array.isArray(next.projects) && next.projects[0] ? next.projects[0].path : null));
					})
					.catch((cause) => mounted.current && setError(cause instanceof Error ? cause.message : String(cause)));
			}, [get]);

			const loadDetail = React.useCallback(
				(path) => {
					if (!path) return Promise.resolve();
					return get(`${STATE_URL}?dir=${encodeURIComponent(path)}`)
						.then((next) => {
							if (mounted.current) setDetail(next);
						})
						.catch(() => {});
				},
				[get],
			);

			const act = React.useCallback(
				(action, path, extra) => {
					setBusy(action === 'sync' ? (extra && extra.direction) || 'pull' : action);
					window
						.fetch(ACTION_URL, {
							method: 'POST',
							headers: { 'content-type': 'application/json', accept: 'application/json' },
							body: JSON.stringify(Object.assign({ action, path }, extra || {})),
						})
						.then((response) => response.json().then((body) => ({ ok: response.ok, body })))
						.then(({ ok, body }) => {
							if (!mounted.current) return;
							if (ok) {
								setState(body);
								setError(null);
								const stillThere = Array.isArray(body.projects) && body.projects.some((project) => project.path === path);
								if (action === 'remove' && path && !stillThere) setSelected(body.projects[0] ? body.projects[0].path : null);
								if (path) loadDetail(path);
							} else setError((body && body.error) || 'Action failed');
						})
						.catch((cause) => mounted.current && setError(cause instanceof Error ? cause.message : String(cause)))
						.finally(() => mounted.current && setBusy(null));
				},
				[loadDetail],
			);

			React.useEffect(() => {
				mounted.current = true;
				load();
				// First visit only; the dialog carries its own opt-out checkbox.
				if (!readTipsDismissed()) setTipsOpen(true);
				const timer = window.setInterval(() => {
					if (!document.hidden) load();
				}, 10000);
				return () => {
					mounted.current = false;
					window.clearInterval(timer);
				};
			}, [load]);

			React.useEffect(() => {
				if (selected) loadDetail(selected);
			}, [selected, loadDetail]);

			const header = h(
				'header',
				{ className: 'hp-head' },
				h('div', { style: { flex: 1, minWidth: 0 } }, h('h1', { className: 'hp-title' }, en.title), h('p', { className: 'hp-sub' }, en.subtitle)),
				h(
					'div',
					{ style: { display: 'flex', gap: '6px', flexShrink: 0 } },
					h(
						'button',
						{ className: 'hp-btn hp-btn-quiet', onClick: () => setTipsOpen(true), 'aria-haspopup': 'dialog' },
						en.tips,
					),
					h(
						'button',
						{
							className: 'hp-btn',
							disabled: Boolean(busy),
							onClick: () => {
								load();
								if (selected) loadDetail(selected);
							},
						},
						busy ? en.busy : en.refresh,
					),
				),
			);

			if (!state) {
				return h(
					'div',
					{ className: 'hp-root' },
					h(
						'div',
						{ className: 'hp-inner' },
						header,
						error
							? h(
									'div',
									{ className: 'hp-err', role: 'alert' },
									h('span', null, `${en.error}: ${error}`),
									h('button', { className: 'hp-btn hp-btn-sm', onClick: load }, en.retry),
								)
							: h(
									'div',
									{ className: 'hp-skel', 'aria-busy': 'true', 'aria-label': en.loading },
									h('div', { className: 'hp-skel-row' }),
									h('div', { className: 'hp-skel-row' }),
									h('div', { className: 'hp-skel-row' }),
								),
					),
					tipsOpen ? h(TipsDialog, { onClose: () => setTipsOpen(false) }) : null,
				);
			}

			const projects = Array.isArray(state.projects) ? state.projects : [];
			const project = projects.find((candidate) => candidate.path === selected);
			const warm = detail && detail.session && detail.session.directory === selected ? detail.session.warm : '';

			return h(
				'div',
				{ className: 'hp-root' },
				h(
					'div',
					{ className: 'hp-inner' },
					header,
					h(VaultStrip, {
						vault: state.vault,
						vaultReady: state.vaultReady,
						busy,
						onSync: (direction) => act('sync', undefined, { direction }),
					}),
					error
						? h(
								'div',
								{ className: 'hp-err', role: 'alert' },
								h('span', null, error),
								h('button', { className: 'hp-btn hp-btn-sm', onClick: () => { setError(null); load(); } }, en.dismiss),
							)
						: null,

					h(
						'div',
						{ className: 'hp-add' },
						h('input', {
							className: 'hp-input hp-mono',
							value: draft,
							placeholder: en.addPlaceholder,
							'aria-label': en.addLabel,
							onChange: (event) => setDraft(event.target.value),
							onKeyDown: (event) => {
								if (event.key === 'Enter' && draft.trim()) {
									const path = draft.trim();
									setDraft('');
									act('add', path);
								}
							},
						}),
						h(
							'button',
							{
								className: 'hp-btn hp-btn-primary',
								disabled: Boolean(busy) || !draft.trim(),
								onClick: () => {
									const path = draft.trim();
									setDraft('');
									act('add', path);
								},
							},
							en.add,
						),
					),

					projects.length === 0
						? h(
								'div',
								{ className: 'hp-note' },
								h('p', { className: 'hp-note-strong' }, en.empty),
								h('p', { style: { margin: 0, maxWidth: '52ch' } }, en.emptyHint),
							)
						: h(
								'div',
								{ className: 'hp-split' },
								h(
									'div',
									{ className: 'hp-list', role: 'list' },
									projects.map((item) =>
										h(
											'button',
											{
												key: item.path,
												className: 'hp-row',
												role: 'listitem',
												onClick: () => setSelected(item.path),
												'aria-pressed': item.path === selected,
											},
											h(
												'span',
												{ className: 'hp-row-top' },
												item.pinned ? h('span', { className: 'hp-pin', title: en.pinned }, h(PinIcon, null)) : null,
												h('span', { className: 'hp-row-name' }, item.slug || item.name),
												h('span', { className: cls('hp-chip', MODE_TONE[item.mode] || 'hp-chip-mute') }, item.mode && item.mode !== 'none' ? item.mode : en.modeNone),
											),
											h('span', { className: 'hp-row-path hp-mono' }, item.path),
											h(
												'span',
												{ className: 'hp-row-meta hp-num' },
												item.error
													? h('span', { className: 'hp-chip hp-chip-warn' }, en.notRepo)
													: [
															item.git && item.git.branch
																? h('span', { key: 'b', className: 'hp-mono', style: { fontSize: '10px' } }, item.git.detached ? en.detached : item.git.branch)
																: null,
															...dirtChips(item.git).map((chip, i) => h('span', { key: `d${i}`, className: cls('hp-chip', chip.tone) }, chip.label)),
														],
											),
										),
									),
								),
								project
									? h(
											'div',
											{ className: 'hp-detail' },
											h(
												'div',
												{ className: 'hp-detail-head' },
												h(
													'div',
													{ style: { flex: 1, minWidth: 0 } },
													h('h2', { className: 'hp-detail-name' }, project.slug || project.name),
													h('p', { className: 'hp-detail-path hp-mono' }, project.path),
												),
												h(
													'span',
													{ style: { display: 'flex', gap: '5px', flexShrink: 0 } },
													h('button', { className: 'hp-btn hp-btn-sm hp-btn-quiet', disabled: Boolean(busy), onClick: () => act('pin', project.path) }, project.pinned ? en.unpin : en.pin),
													h('button', { className: 'hp-btn hp-btn-sm hp-btn-quiet', disabled: Boolean(busy), onClick: () => act('remove', project.path) }, en.forget),
												),
											),
											h(
												'div',
												{ className: 'hp-body' },
												project.error
													? h(
															'div',
															{ className: 'hp-block' },
															h('p', { className: 'hp-block-label' }, en.status),
															h('p', { style: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } }, project.error),
														)
													: h(
															'div',
															{ className: 'hp-block' },
															h('p', { className: 'hp-block-label' }, en.repository),
															h(
																'div',
																{ className: 'hp-facts hp-num' },
																h(
																	'div',
																	{ className: 'hp-fact' },
																	h('span', { className: 'hp-fact-k' }, 'Branch'),
																	h('span', { className: 'hp-fact-v hp-mono' }, project.git && project.git.branch ? (project.git.detached ? en.detached : project.git.branch) : '—'),
																),
																h('div', { className: 'hp-fact' }, h('span', { className: 'hp-fact-k' }, en.sync), h('span', { className: 'hp-fact-v' }, driftText(project.git) || '—')),
																h(
																	'div',
																	{ className: 'hp-fact' },
																	h('span', { className: 'hp-fact-k' }, en.workingTree),
																	h('span', { className: 'hp-fact-v' }, project.git && (project.git.dirty || project.git.untracked) ? `${project.git.dirty || 0} modified · ${project.git.untracked || 0} untracked` : en.clean),
																),
																h(
																	'div',
																	{ className: 'hp-fact' },
																	h('span', { className: 'hp-fact-k' }, en.vault),
																	h('span', { className: 'hp-fact-v' }, project.mode && project.mode !== 'none' ? project.mode : en.modeNone),
																),
															),
														),
												project.git && project.git.commits && project.git.commits.length
													? h(
															'div',
															{ className: 'hp-block' },
															h('p', { className: 'hp-block-label' }, en.commits),
															h(
																'ol',
																{ className: 'hp-commits' },
																project.git.commits.slice(0, 5).map((commit) =>
																	h(
																		'li',
																		{ key: commit.hash, className: 'hp-commit' },
																		h('span', { className: 'hp-commit-hash hp-mono' }, commit.short),
																		h(
																			'span',
																			{ className: 'hp-commit-txt' },
																			h('span', { className: 'hp-commit-subj', title: commit.subject }, commit.subject),
																			h('span', { className: 'hp-commit-by' }, ` · ${commit.author}, ${commit.date}`),
																		),
																	),
																),
															),
														)
													: null,
												h(
													'div',
													{ className: 'hp-block' },
													h('p', { className: 'hp-block-label' }, en.warm),
													warm
														? h('pre', { className: 'hp-warm hp-mono' }, warm)
														: h('p', { style: { margin: 0, fontSize: '11.5px', color: 'var(--dsw-alias-label-secondary)', maxWidth: '62ch' } }, en.warmEmpty),
												),
											),
										)
									: h('div', { className: 'hp-note' }, h('p', { style: { margin: 0 } }, en.select)),
							),

					h('div', { className: 'hp-foot' }, h('span', null, en.registry), h('span', { className: 'hp-mono' }, state.registryPath || '—')),
				),
				tipsOpen ? h(TipsDialog, { onClose: () => setTipsOpen(false) }) : null,
			);
		}

		function PanelIcon(props) {
			const size = props && typeof props.size === 'number' ? props.size : 18;
			return h(
				'svg',
				{ width: size, height: size, viewBox: '0 0 18 18', fill: 'none', 'aria-hidden': true, focusable: 'false' },
				h('path', { d: 'M5 3.2v8.6', stroke: 'currentColor', strokeWidth: '1.5', strokeLinecap: 'round' }),
				h('path', { d: 'M5 5.2c0 3 5.2 2 5.2 5v2.6', stroke: 'currentColor', strokeWidth: '1.5', strokeLinecap: 'round' }),
				h('circle', { cx: 5, cy: 2.9, r: 1.55, fill: 'currentColor' }),
				h('circle', { cx: 5, cy: 13.1, r: 1.55, fill: 'currentColor' }),
				h('circle', { cx: 10.2, cy: 13.1, r: 1.55, fill: 'currentColor' }),
			);
		}

		return {
			inject: ['slots', 'locale'],
			apply(ctx) {
				const t = ctx.locale.bind(NS);
				ctx.effect(() => ctx.locale.register(NS, 'en', en), 'harness-projects: copy');
				ctx.effect(() => installCss(), 'harness-projects: stylesheet');
				ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, ProjectsPanel));
				ctx.slots.inject('sidebar.panellist', () =>
					ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => t('panel'), locale: NS }, PanelIcon),
				);
			},
		};
	},
});
