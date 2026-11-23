import Link from "next/link";

/** "Back to the list" above an open detail on stacked layouts: a jump to the list's anchor. */
export function BackTo({
  href,
  label,
  className = "",
}: {
  href: `#${string}`;
  label: string;
  className?: string;
}) {
  return (
    <Link href={href} className={`atrium-link text-ui-sm mb-4 inline-block ${className}`}>
      {label}
    </Link>
  );
}
