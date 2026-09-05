import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { BadRequestError } from "./errors";
import { imageDownloadRateLimiter } from "./async-rate-limiter";

const MAX_BYTES = 20 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 4;
const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const)
  blocked.addSubnet(address, prefix, "ipv4");
const publicV6 = new BlockList();
publicV6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const)
  blocked.addSubnet(address, prefix, "ipv6");

function assertPublicAddress(address: string): void {
  const family = isIP(address);
  if (
    (family === 4 && !blocked.check(address, "ipv4")) ||
    (family === 6 &&
      publicV6.check(address, "ipv6") &&
      !blocked.check(address, "ipv6"))
  )
    return;
  throw new BadRequestError(
    "Image URL must resolve to a public Internet address"
  );
}

async function download(
  url: URL,
  signal: AbortSignal,
  redirects = 0
): Promise<Buffer> {
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port
  ) {
    throw new BadRequestError(
      "Image URL must use HTTP or HTTPS on its standard port, without credentials"
    );
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  // Validate every DNS answer, then pin the socket to the selected address. A
  // second DNS lookup during connect would reintroduce DNS-rebinding attacks.
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await Promise.race([
        lookup(hostname, { all: true }),
        new Promise<never>((_, reject) => {
          if (signal.aborted) reject(signal.reason);
          else
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
        }),
      ]);
  if (addresses.length === 0)
    throw new BadRequestError("Image hostname has no address");
  addresses.forEach(({ address }) => assertPublicAddress(address));
  signal.throwIfAborted();
  // Prefer IPv4 when available so dual-stack DNS also works on hosts without
  // IPv6 connectivity. IPv6-only public providers remain supported.
  const pinned = addresses.find(({ family }) => family === 4) ?? addresses[0];
  const target = new URL(url);
  target.hostname =
    pinned.family === 6 ? `[${pinned.address}]` : pinned.address;
  return new Promise<Buffer>((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      target,
      {
        agent: false,
        signal,
        headers: {
          Host: url.host,
          Accept: "image/*",
          "Accept-Encoding": "identity",
        },
        // Connect directly to the validated IP, keeping the original hostname for
        // TLS certificate validation and SNI. Bun's custom lookup callback is not
        // compatible with node:https on all supported runtimes.
        ...(url.protocol === "https:" && !isIP(hostname)
          ? { servername: hostname }
          : {}),
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          response.destroy();
          if (!response.headers.location || redirects >= MAX_REDIRECTS) {
            reject(
              new BadRequestError(
                "Image download exceeded redirect limit or has no redirect destination"
              )
            );
            return;
          }
          try {
            resolve(
              download(
                new URL(response.headers.location, url),
                signal,
                redirects + 1
              )
            );
          } catch (error) {
            reject(error);
          }
          return;
        }
        if (
          status < 200 ||
          status >= 300 ||
          !response.headers["content-type"]
            ?.toLowerCase()
            .startsWith("image/") ||
          (response.headers["content-encoding"] &&
            response.headers["content-encoding"] !== "identity")
        ) {
          response.destroy();
          reject(
            new BadRequestError(
              "Image URL did not return a supported image response"
            )
          );
          return;
        }
        const declaredSize = Number(response.headers["content-length"]);
        if (declaredSize > MAX_BYTES) {
          response.destroy();
          reject(new BadRequestError("Downloaded image exceeds 20 MiB limit"));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            response.destroy(
              new BadRequestError("Downloaded image exceeds 20 MiB limit")
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          if (size < 100)
            reject(new BadRequestError("Downloaded image is too small"));
          else resolve(Buffer.concat(chunks, size));
        });
      }
    );
    request.on("error", reject);
    request.end();
  });
}

/** Fetch a bounded public image; callers still decode/validate it with Sharp. */
export async function downloadRemoteImage(input: string): Promise<Buffer> {
  return imageDownloadRateLimiter.schedule(async () => {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new BadRequestError("Image download timed out")),
      TIMEOUT_MS
    );
    try {
      return await download(new URL(input), controller.signal);
    } catch (error) {
      if (error instanceof BadRequestError) throw error;
      throw new BadRequestError(
        controller.signal.aborted
          ? "Image download timed out"
          : "Unable to download image from URL"
      );
    } finally {
      clearTimeout(timer);
    }
  });
}
