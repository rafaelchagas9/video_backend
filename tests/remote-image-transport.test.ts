import { afterAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";

type ResponsePlan = {
  status?: number;
  headers?: Record<string, string>;
  chunks?: Buffer[];
  hang?: boolean;
};
let plans: ResponsePlan[] = [];
const requests: Array<{ url: URL; options: RequestOptions; address: string }> =
  [];
let dnsAnswers: Array<{ address: string; family: number }> = [
  { address: "93.184.216.34", family: 4 },
];
let dnsHang = false;
let ipv6Unavailable = false;
let lookups = 0;
mock.module("node:dns/promises", () => ({
  lookup: async () => {
    lookups++;
    if (dnsHang) return new Promise(() => {});
    return dnsAnswers;
  },
}));
const request = (
  url: URL,
  options: RequestOptions,
  callback: (response: IncomingMessage) => void
) => {
  const req = new EventEmitter() as EventEmitter & { end: () => void };
  const plan = plans.shift() ?? {};
  let response: PassThrough;
  const address = url.hostname.replace(/^\[|\]$/g, "");
  requests.push({ url, options, address });
  req.end = () =>
    queueMicrotask(() => {
      if (ipv6Unavailable && address.includes(":")) {
        req.emit("error", new Error("IPv6 network unreachable"));
        return;
      }
      response = new PassThrough();
      Object.assign(response, {
        statusCode: plan.status ?? 200,
        headers: plan.headers ?? { "content-type": "image/jpeg" },
      });
      callback(response as unknown as IncomingMessage);
      if (!plan.hang) {
        for (const chunk of plan.chunks ?? [Buffer.alloc(150, 1)])
          response.write(chunk);
        response.end();
      }
    });
  options.signal?.addEventListener(
    "abort",
    () => {
      req.emit("error", options.signal?.reason);
      response?.destroy();
    },
    { once: true }
  );
  return req;
};
mock.module("node:http", () => ({ request }));
mock.module("node:https", () => ({ request }));
mock.module("@/utils/async-rate-limiter", () => ({
  imageDownloadRateLimiter: {
    schedule: (operation: () => unknown) => operation(),
  },
}));
const nativeTimeout = globalThis.setTimeout;
const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
  fn: (...args: unknown[]) => void,
  ms: number,
  ...args: unknown[]
) => nativeTimeout(fn, ms === 15_000 ? 30 : ms, ...args)) as typeof setTimeout);
const { downloadRemoteImage } = await import("@/utils/remote-image-download");
afterAll(() => {
  timer.mockRestore();
  mock.restore();
});
beforeEach(() => {
  plans = [];
  requests.length = 0;
  dnsHang = false;
  ipv6Unavailable = false;
  lookups = 0;
  dnsAnswers = [{ address: "93.184.216.34", family: 4 }];
});

test("pins validated DNS to the socket while retaining the hostname for TLS and Host", async () => {
  const image = await downloadRemoteImage(
    "https://images.example/portrait.jpg"
  );
  expect(image).toEqual(Buffer.alloc(150, 1));
  expect(lookups).toBe(1);
  expect(requests).toHaveLength(1);
  expect(requests[0].address).toBe("93.184.216.34");
  expect(requests[0].url.hostname).toBe("93.184.216.34");
  expect(requests[0].options.servername).toBe("images.example");
  expect(requests[0].options.headers).toMatchObject({ Host: "images.example" });
  expect(requests[0].options.agent).toBe(false);
});
test("rejects mixed public/private DNS answers before connecting", async () => {
  dnsAnswers.push({ address: "127.0.0.1", family: 4 });
  await expect(
    downloadRemoteImage("http://images.example/a")
  ).rejects.toMatchObject({ statusCode: 400 });
  expect(requests).toHaveLength(0);
});
test("accepts a public IPv6 address and passes the pinned family", async () => {
  dnsAnswers = [{ address: "2606:4700:4700::1111", family: 6 }];
  expect((await downloadRemoteImage("https://images.example/a")).length).toBe(
    150
  );
  expect(requests[0].address).toBe("2606:4700:4700::1111");
});
test("validates redirects before opening another socket", async () => {
  plans = [
    {
      status: 302,
      headers: { location: "http://169.254.169.254/latest/meta-data" },
    },
  ];
  await expect(
    downloadRemoteImage("https://images.example/a")
  ).rejects.toMatchObject({ statusCode: 400 });
  expect(requests).toHaveLength(1);
});
test("follows relative public redirects and bounds loops", async () => {
  plans = [{ status: 302, headers: { location: "/next" } }, {}];
  expect((await downloadRemoteImage("https://images.example/a")).length).toBe(
    150
  );
  expect(requests[1].url.pathname).toBe("/next");
  requests.length = 0;
  plans = Array.from({ length: 6 }, () => ({
    status: 302,
    headers: { location: "/loop" },
  }));
  await expect(downloadRemoteImage("https://images.example/a")).rejects.toThrow(
    "redirect limit"
  );
  expect(requests).toHaveLength(5);
});
test("rejects a declared oversized image and an unbounded chunked body", async () => {
  plans = [
    {
      headers: {
        "content-type": "image/png",
        "content-length": String(21 * 1024 * 1024),
      },
    },
  ];
  await expect(downloadRemoteImage("https://images.example/a")).rejects.toThrow(
    "20 MiB"
  );
  plans = [
    {
      chunks: [Buffer.alloc(11 * 1024 * 1024), Buffer.alloc(10 * 1024 * 1024)],
    },
  ];
  await expect(downloadRemoteImage("https://images.example/a")).rejects.toThrow(
    "20 MiB"
  );
});
test("rejects HTML, error statuses, compressed responses and tiny images", async () => {
  const invalidResponses: ResponsePlan[] = [
    { headers: { "content-type": "text/html" } },
    { status: 404 },
    { headers: { "content-type": "image/png", "content-encoding": "gzip" } },
    { chunks: [Buffer.alloc(99)] },
  ];
  for (const plan of invalidResponses) {
    plans = [plan];
    await expect(
      downloadRemoteImage("https://images.example/a")
    ).rejects.toMatchObject({ statusCode: 400 });
  }
});
test("times out slow bodies and stalled DNS resolution", async () => {
  plans = [{ hang: true }];
  await expect(downloadRemoteImage("https://images.example/a")).rejects.toThrow(
    "timed out"
  );
  dnsHang = true;
  await expect(downloadRemoteImage("https://images.example/a")).rejects.toThrow(
    "timed out"
  );
});

test("downloads a dual-stack host on an IPv4-only connection", async () => {
  ipv6Unavailable = true;
  dnsAnswers = [
    { address: "2606:4700:4700::1111", family: 6 },
    { address: "93.184.216.34", family: 4 },
  ];
  expect((await downloadRemoteImage("https://images.example/a")).length).toBe(
    150
  );
});
