import { useState } from "react";
import { AddRepo, RemoveRepo } from "../../wailsjs/go/main/App";

export async function handleAdd(): Promise<string> {
  return await AddRepo();
}

export async function handleRemove(name: string): Promise<string> {
  return await RemoveRepo(name);
}

export function Repos(props: { names: string[] }) {
  const [message, setMessage] = useState("");

  const show = (next: string): void => {
    setMessage(next);
  };

  const onAdd = async (): Promise<void> => {
    show(await handleAdd());
  };

  const onRemove = async (name: string): Promise<void> => {
    show(await handleRemove(name));
  };

  return (
    <div className="repos">
      <div className="repos-bar">
        <button type="button" className="repos-add" onClick={() => void onAdd()}>
          Add repo
        </button>
        {props.names.map((name) => (
          <span className="repos-item" key={name}>
            <span className="repos-name">{name}</span>
            <button
              type="button"
              className="repos-remove"
              aria-label={`Remove ${name}`}
              onClick={() => void onRemove(name)}
            >
              Remove
            </button>
          </span>
        ))}
      </div>
      {message !== "" ? <p className="repos-message muted">{message}</p> : null}
    </div>
  );
}
