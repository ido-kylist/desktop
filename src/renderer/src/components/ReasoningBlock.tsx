/**
 * The model's thinking, collapsed and out of the way.
 *
 * A native `<details>` rather than a React-controlled disclosure: it is closed by
 * default with no `open` attribute, keyboard-accessible for free, and keeps this
 * component stateless. Reasoning is not persisted, so it only survives while the
 * answer is on screen.
 */
export function ReasoningBlock({ text }: { text: string }): React.JSX.Element {
  return (
    <details className="reasoning">
      <summary>Reasoning</summary>
      <pre className="reasoning-body">{text}</pre>
    </details>
  );
}
