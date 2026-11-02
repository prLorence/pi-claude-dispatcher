import type { Settings } from "../shared/types";
import { Repos } from "./Repos";

interface SettingsPanelProps {
  settings: Settings;
  onChange: (next: Settings) => void;
  repoNames: string[];
  message: string;
}

export function SettingsPanel(props: SettingsPanelProps) {
  const { settings, onChange, repoNames, message } = props;

  return (
    <section className="settings-panel" aria-label="Settings">
      <h2 className="settings-title">Settings</h2>
      <div className="settings-toggles">
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={settings.ompSessions}
            onChange={(event) => {
              onChange({ ...settings, ompSessions: event.target.checked });
            }}
          />
          <span>omp sessions</span>
        </label>
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={settings.piSessions}
            onChange={(event) => {
              onChange({ ...settings, piSessions: event.target.checked });
            }}
          />
          <span>Pi sessions</span>
        </label>
      </div>
      <fieldset className="settings-scope">
        <legend>Scope</legend>
        <label className="settings-scope-option">
          <input
            type="radio"
            name="settings-scope"
            checked={settings.scope === "repos"}
            onChange={() => {
              onChange({ ...settings, scope: "repos" });
            }}
          />
          <span>Added repos only</span>
        </label>
        <label className="settings-scope-option">
          <input
            type="radio"
            name="settings-scope"
            checked={settings.scope === "all"}
            onChange={() => {
              onChange({ ...settings, scope: "all" });
            }}
          />
          <span>All sessions</span>
        </label>
      </fieldset>
      <p className="settings-note muted">
        All sessions also shows sessions of repos you did not add.
      </p>
      <div className="settings-repos">
        <h3 className="settings-heading">Repos</h3>
        <Repos names={repoNames} />
      </div>
      {message !== "" ? <p className="settings-message muted">{message}</p> : null}
    </section>
  );
}
