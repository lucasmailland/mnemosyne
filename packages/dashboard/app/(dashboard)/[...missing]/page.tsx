import { notFound } from "next/navigation";

import { titled } from "@/lib/i18n/server";

// The page's own title: the group not-found's metadata is not applied here.
export const generateMetadata = titled("lethe.notFoundName");

/**
 * Any path no room claims. Without this an unknown URL fell through to the root
 * not-found, outside the shell; here the group's not-found renders inside it (and
 * the group layout still sends a signed-out visitor to the login first).
 */
export default function MissingPage(): never {
  notFound();
}
