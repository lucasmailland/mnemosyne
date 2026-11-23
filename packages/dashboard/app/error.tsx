"use client";

import { Lethe } from "@/components/lethe";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main>
      <Lethe
        kind="error"
        digest={error.digest}
        reset={reset}
        home={{ href: "/", label: "lethe.toDashboard" }}
      />
    </main>
  );
}
