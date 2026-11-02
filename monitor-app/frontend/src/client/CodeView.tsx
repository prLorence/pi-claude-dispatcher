import type { CodeBlock } from "../shared/types";
import { highlightHtml, languageFor, splitFences } from "./highlight";

const COLLAPSE_LINES = 200;

// The only component that inserts highlighted markup. The string always comes from
// highlightHtml, which escapes the text before it adds token spans.
function Highlighted(props: { text: string; language: string | null }) {
  const html = highlightHtml(props.text, props.language);
  if (html === null) return <>{props.text}</>;
  // pi-lens-ignore: dangerously-set-inner-html -- highlightHtml escapes the text before adding spans
  return <span className="hljs" dangerouslySetInnerHTML={{ __html: html }} />;
}

function Body(props: { text: string; language: string | null }) {
  return (
    <pre className="code-body">
      <Highlighted text={props.text} language={props.language} />
    </pre>
  );
}

export function CodeView(props: { block: CodeBlock; language?: string | null }) {
  const block = props.block;
  const language = props.language ?? languageFor(block.path, block.kind);
  const head = block.path ?? block.kind;
  const lines = block.text.split("\n");

  return (
    <div className={`code-view code-${block.kind}`}>
      <div className="code-head">{head}</div>
      {lines.length <= COLLAPSE_LINES ? (
        <Body text={block.text} language={language} />
      ) : (
        <>
          <Body text={lines.slice(0, COLLAPSE_LINES).join("\n")} language={language} />
          <details className="code-more">
            <summary>{lines.length - COLLAPSE_LINES} more lines</summary>
            <Body text={lines.slice(COLLAPSE_LINES).join("\n")} language={language} />
          </details>
        </>
      )}
    </div>
  );
}

type RowClass = "added" | "removed" | "separator" | "context";

function rowOf(line: string): { cls: RowClass; sign: string; code: string } {
  if (line.startsWith("@@")) return { cls: "separator", sign: "", code: line };
  if (line.startsWith("+")) return { cls: "added", sign: "+", code: line.slice(1) };
  if (line.startsWith("-")) return { cls: "removed", sign: "-", code: line.slice(1) };
  if (line.startsWith(" ")) return { cls: "context", sign: " ", code: line.slice(1) };
  return { cls: "context", sign: " ", code: line };
}

export function DiffView(props: { block: CodeBlock; language?: string | null }) {
  const block = props.block;
  const language = props.language ?? languageFor(block.path, block.kind);

  return (
    <div className={`code-view code-diff`}>
      <div className="code-head">{block.path ?? "diff"}</div>
      <div className="diff-body">
        {block.text.split("\n").map((line, index) => {
          const row = rowOf(line);
          return (
            <div key={index} className={`diff-row diff-${row.cls}`}>
              {row.cls === "separator" ? (
                <span className="diff-sep">{row.code}</span>
              ) : (
                <>
                  <span className="diff-sign">{row.sign}</span>
                  <span className="diff-code">
                    <Highlighted text={row.code} language={language} />
                  </span>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function AssistantText(props: { text: string }) {
  return (
    <>
      {splitFences(props.text).map((segment, index) =>
        segment.type === "code" ? (
          <CodeView
            key={index}
            block={{ kind: "file", path: null, text: segment.text }}
            language={segment.lang}
          />
        ) : (
          <p key={index}>{segment.text}</p>
        ),
      )}
    </>
  );
}
