/** One label and value of a detail's meta row; use inside a <dl>. */
export function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="eyebrow mb-1 font-medium">{label}</dt>
      <dd className="text-text-muted text-ui-xs">{children}</dd>
    </div>
  );
}
