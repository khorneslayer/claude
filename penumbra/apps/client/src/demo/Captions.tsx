export function Caption({ text }: { text?: string | null }) {
  if (!text) return null;
  return (
    <div className="caption" role="status" aria-live="polite">
      {text}
    </div>
  );
}
