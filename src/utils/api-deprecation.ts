import type { FastifyReply } from "fastify";

const DEFAULT_SUNSET = "Thu, 31 Dec 2026 23:59:59 GMT";

type DeprecatedRouteOptions = {
  replacement?: string;
  details?: string;
  sunset?: string;
};

export function markRouteDeprecated(
  reply: FastifyReply,
  options: DeprecatedRouteOptions = {},
): void {
  const replacementMessage = options.replacement
    ? `Use ${options.replacement} instead.`
    : "See API normalization docs for the replacement route.";
  const detailsSuffix = options.details ? ` ${options.details}` : "";

  reply.header("Deprecation", "true");
  reply.header("Sunset", options.sunset ?? DEFAULT_SUNSET);
  reply.header("Warning", `299 - "Deprecated API route. ${replacementMessage}${detailsSuffix}"`);

  if (options.replacement) {
    reply.header("Link", `<${options.replacement}>; rel="successor-version"`);
  }
}
