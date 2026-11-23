import { titled } from "@/lib/i18n/server";

/** Only the document title: the page itself is a client component. */
export const generateMetadata = titled("auth.eyebrowSetup");

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
