import { Lethe } from "@/components/lethe";
import { titled } from "@/lib/i18n/server";

export const generateMetadata = titled("lethe.notFoundName");

/** Inside the group the layout still draws the shell around this. */
export default function DashboardNotFound() {
  return <Lethe kind="notFound" home={{ href: "/", label: "lethe.toAtrium" }} />;
}
