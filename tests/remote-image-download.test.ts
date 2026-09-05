import { describe, expect, test } from "bun:test";
import { downloadRemoteImage } from "@/utils/remote-image-download";

describe("remote image destination policy", () => {
  for (const url of [
    "file:///etc/passwd",
    "http://user:pass@example.com/image",
    "http://127.0.0.1/a",
    "http://2130706433/a",
    "http://0x7f000001/a",
    "http://10.1.1.1/a",
    "http://169.254.169.254/a",
    "http://192.168.1.1/a",
    "http://100.64.0.1/a",
    "http://[::1]/a",
    "http://[::ffff:127.0.0.1]/a",
    "http://[fc00::1]/a",
    "http://[fe80::1]/a",
    "http://[2002:7f00:1::]/a",
    "http://[2001:db8::1]/a",
    "http://[64:ff9b::7f00:1]/a",
    "http://example.com:3000/a",
  ]) {
    test(`rejects ${url}`, async () => {
      await expect(downloadRemoteImage(url)).rejects.toMatchObject({
        statusCode: 400,
      });
    });
  }
});
