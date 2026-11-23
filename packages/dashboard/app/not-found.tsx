import { Lethe } from "@/components/lethe";
import { titled } from "@/lib/i18n/server";

export const generateMetadata = titled("lethe.notFoundName");

/**
 * The scene alone, outside the shell. Unknown paths normally never get here: the
 * (dashboard) catch-all takes them (in the shell, or the login when signed out).
 */
export default function NotFound() {
  return (
    <main>
      <Lethe kind="notFound" home={{ href: "/login", label: "lethe.toLogin" }} />
    </main>
  );
}
