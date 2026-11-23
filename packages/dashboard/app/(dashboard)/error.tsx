"use client";

import { Lethe } from "@/components/lethe";

/** Errors inside the dashboard keep the shell: the layout wraps this boundary. */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <>
      <Lethe
        kind="error"
        digest={error.digest}
        reset={reset}
        home={{ href: "/", label: "lethe.toAtrium" }}
      />
    </>
  );
}
