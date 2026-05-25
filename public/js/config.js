// Edition + feature flags. The build script replaces `__ORBIT_EDITION__`
// via esbuild --define when producing dist/preview; in dev (raw modules
// served from public/) the identifier is undefined and we fall back to
// "full". `typeof` is the safe probe — bare reads of an undefined global
// would throw.

let resolvedEdition = "full";
if (typeof __ORBIT_EDITION__ !== "undefined") {
  resolvedEdition = __ORBIT_EDITION__;
}

export const edition = resolvedEdition; // "full" | "preview"

export const features = {
  sse: edition === "full",
  ai: edition === "full",
  multiBoard: edition === "full",
  tokenAuth: edition === "full",
  attachments: edition === "full"
};
