import type { StaticImageData } from "next/image";

import echo from "@/public/brand/echo-th.jpg";
import medallionRays from "@/public/brand/medallion-rays-th.jpg";
import wideRays from "@/public/brand/wide-rays-th.jpg";
import frieze from "@/public/brand/frieze-th.jpg";
import seal from "@/public/brand/seal-th.jpg";
import panoPalace from "@/public/brand/pano-palace-th.jpg";
import library from "@/public/brand/library-th.jpg";
import libraryBand from "@/public/brand/library-band-th.jpg";
import panoWater from "@/public/brand/pano-water-th.jpg";
import constellation from "@/public/brand/constellation-th.jpg";
import lethe from "@/public/brand/lethe-th.jpg";
import meander from "@/public/brand/meander-th.jpg";
import objCardCatalog from "@/public/brand/obj-card-catalog-th.jpg";
import objColumbarium from "@/public/brand/obj-columbarium-th.jpg";
import objAstrolabe from "@/public/brand/obj-astrolabe-th.jpg";
import objHerbarium from "@/public/brand/obj-herbarium-th.jpg";
import objQuipu from "@/public/brand/obj-quipu-th.jpg";
import objWaxTablet from "@/public/brand/obj-wax-tablet-th.jpg";
import planFloor from "@/public/brand/plan-floor-th.jpg";
import planSection from "@/public/brand/plan-section-th.jpg";
import planElevation from "@/public/brand/plan-elevation-th.jpg";
import planAxon from "@/public/brand/plan-axon-th.jpg";
import bustFrieze from "@/public/brand/bust-frieze-th.jpg";
import iconStore from "@/public/brand/icons/store.svg";
import iconSearch from "@/public/brand/icons/search.svg";
import iconRecall from "@/public/brand/icons/recall.svg";
import iconSession from "@/public/brand/icons/session.svg";
import iconEmbed from "@/public/brand/icons/embed.svg";
import iconPersist from "@/public/brand/icons/persist.svg";
import iconRemember from "@/public/brand/icons/remember.svg";
import iconForget from "@/public/brand/icons/forget.svg";
import spinner from "@/public/brand/spinner.svg";

export type BrandImageId =
  | "echo"
  | "medallion-rays"
  | "wide-rays"
  | "frieze"
  | "seal"
  | "pano-palace"
  | "library"
  | "library-band"
  | "pano-water"
  | "constellation"
  | "lethe"
  | "meander"
  | "obj-card-catalog"
  | "obj-columbarium"
  | "obj-astrolabe"
  | "obj-herbarium"
  | "obj-quipu"
  | "obj-wax-tablet"
  | "plan-floor"
  | "plan-section"
  | "plan-elevation"
  | "plan-axon"
  | "bust-frieze";

export const BRAND_IMAGES: Record<BrandImageId, StaticImageData> = {
  echo,
  "medallion-rays": medallionRays,
  "wide-rays": wideRays,
  frieze,
  seal,
  "pano-palace": panoPalace,
  library,
  "library-band": libraryBand,
  "pano-water": panoWater,
  constellation,
  lethe,
  meander,
  "obj-card-catalog": objCardCatalog,
  "obj-columbarium": objColumbarium,
  "obj-astrolabe": objAstrolabe,
  "obj-herbarium": objHerbarium,
  "obj-quipu": objQuipu,
  "obj-wax-tablet": objWaxTablet,
  "plan-floor": planFloor,
  "plan-section": planSection,
  "plan-elevation": planElevation,
  "plan-axon": planAxon,
  "bust-frieze": bustFrieze,
};

export type BrandIconId =
  "store" | "search" | "recall" | "session" | "embed" | "persist" | "remember" | "forget";

export const BRAND_ICONS: Record<BrandIconId, StaticImageData> = {
  store: iconStore,
  search: iconSearch,
  recall: iconRecall,
  session: iconSession,
  embed: iconEmbed,
  persist: iconPersist,
  remember: iconRemember,
  forget: iconForget,
};

export const SPINNER: StaticImageData = spinner;
