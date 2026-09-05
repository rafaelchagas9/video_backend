import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import * as fsPromises from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

const settings = {
  DEMO_MODE: false,
  PROFILE_PICTURES_DIR: "",
  PROFILE_PICTURE_FORMAT: "webp",
  PROFILE_PICTURE_QUALITY: 80,
  PROFILE_PICTURE_MAX_SIZE: 512,
};
let studio = {
  id: 7,
  name: "Fixture studio",
  description: null,
  profilePicturePath: "" as string | null,
  createdAt: new Date("2026-09-04T00:00:00Z"),
  updatedAt: new Date("2026-09-04T00:00:00Z"),
};
let updateError: Error | undefined;
let failWrite = false;
const openFile = fsPromises.open;
mock.module("fs/promises", () => ({
  ...fsPromises,
  open: async (...args: Parameters<typeof openFile>) => {
    const file = await openFile(...args);
    if (failWrite) {
      const write = file.writeFile.bind(file);
      file.writeFile = async () => {
        await write("partial candidate");
        throw new Error("disk full");
      };
    }
    return file;
  },
}));
const processPicture = mock(
  async (_options: unknown): Promise<Buffer> => Buffer.from("processed fixture")
);
const warn = mock(() => undefined);
const update = mock(() => ({
  set: (values: Partial<typeof studio>) => ({
    where: () => {
      const commit = () => {
        if (updateError) throw updateError;
        if (studio.profilePicturePath) {
          expect(existsSync(studio.profilePicturePath)).toBe(true);
        }
        studio = { ...studio, ...values };
        return [studio];
      };
      return {
        returning: async () => commit(),
      };
    },
  }),
}));
mock.module("@/config/env", () => ({ env: settings }));
mock.module("@/config/drizzle", () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [studio] }) }),
    }),
    update,
  },
}));
mock.module("@/utils/image-processing", () => ({
  processProfilePicture: processPicture,
}));
mock.module("@/utils/logger", () => ({ logger: { warn } }));
const downloadImage = mock(async (_url: string) => Buffer.alloc(100));
mock.module("@/utils/remote-image-download", () => ({
  downloadRemoteImage: downloadImage,
}));
mock.module("@/modules/studios/studios.demo.service", () => ({
  studiosDemoService: {},
}));
mock.module("@/modules/media/demo-media-assets.service", () => ({
  demoMediaAssetsService: {},
}));

let service: import("@/modules/studios/studios.social.service").StudiosSocialService;
let directory: string;
let oldPath: string;

beforeAll(async () => {
  const { StudiosSocialService } =
    await import("@/modules/studios/studios.social.service");
  service = new StudiosSocialService();
});
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "studio-picture-test-"));
  settings.PROFILE_PICTURES_DIR = directory;
  oldPath = join(directory, "old.webp");
  writeFileSync(oldPath, "old fixture");
  studio.profilePicturePath = oldPath;
  updateError = undefined;
  failWrite = false;
  update.mockClear();
  warn.mockClear();
  processPicture.mockReset();
  processPicture.mockImplementation(async () =>
    Buffer.from("processed fixture")
  );
});
afterEach(() => {
  mock.restore();
  rmSync(directory, { recursive: true, force: true });
});

function expectOldPicturePreserved() {
  expect(studio.profilePicturePath).toBe(oldPath);
  expect(readFileSync(oldPath, "utf8")).toBe("old fixture");
}

describe("studio picture replacement", () => {
  it("preserves the current picture when image processing fails", async () => {
    processPicture.mockRejectedValueOnce(new Error("invalid image"));
    await expect(
      service.uploadProfilePicture(7, Buffer.alloc(100), "input.png")
    ).rejects.toThrow("invalid image");
    expectOldPicturePreserved();
    expect(update).not.toHaveBeenCalled();
    expect(readdirSync(directory)).toEqual(["old.webp"]);
  });

  it("preserves the current picture when writing the candidate fails", async () => {
    const invalidDirectory = join(directory, "not-a-directory");
    writeFileSync(invalidDirectory, "fixture");
    settings.PROFILE_PICTURES_DIR = invalidDirectory;
    await expect(
      service.uploadProfilePicture(7, Buffer.alloc(100), "input.png")
    ).rejects.toThrow();
    expectOldPicturePreserved();
    expect(update).not.toHaveBeenCalled();
  });

  it("cleans up a partially written candidate without touching the current picture", async () => {
    failWrite = true;
    await expect(
      service.uploadProfilePicture(7, Buffer.alloc(100), "input.png")
    ).rejects.toThrow("disk full");
    expectOldPicturePreserved();
    expect(update).not.toHaveBeenCalled();
    expect(readdirSync(directory)).toEqual(["old.webp"]);
  });

  it("removes the candidate and preserves the current picture when the database update fails", async () => {
    updateError = new Error("database unavailable");
    await expect(
      service.uploadProfilePicture(7, Buffer.alloc(100), "input.png")
    ).rejects.toThrow("database unavailable");
    expectOldPicturePreserved();
    expect(readdirSync(directory)).toEqual(["old.webp"]);
  });

  it("publishes unique replacements even when the clock does not advance", async () => {
    spyOn(Date, "now").mockReturnValue(123);
    const first = await service.uploadProfilePicture(
      7,
      Buffer.alloc(100),
      "input.png"
    );
    const firstPath = first.profile_picture_path!;
    expect(existsSync(oldPath)).toBe(false);
    expect(readFileSync(firstPath, "utf8")).toBe("processed fixture");
    const second = await service.uploadProfilePicture(
      7,
      Buffer.alloc(100),
      "input.png"
    );
    expect(second.profile_picture_path).not.toBe(firstPath);
    expect(existsSync(firstPath)).toBe(false);
    expect(readFileSync(second.profile_picture_path!, "utf8")).toBe(
      "processed fixture"
    );
    expect(readdirSync(directory)).toHaveLength(1);
  });

  it("returns the committed replacement when old-file cleanup fails", async () => {
    rmSync(oldPath);
    mkdirSync(oldPath);
    const result = await service.uploadProfilePicture(
      7,
      Buffer.alloc(100),
      "input.png"
    );
    expect(result.profile_picture_path).toBe(studio.profilePicturePath);
    expect(readFileSync(result.profile_picture_path!, "utf8")).toBe(
      "processed fixture"
    );
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("uses the same failure-safe replacement flow for downloaded pictures", async () => {
    downloadImage.mockClear();
    updateError = new Error("database unavailable");
    await expect(
      service.setPictureFromUrl(7, "https://example.test/picture.png")
    ).rejects.toThrow("database unavailable");
    expect(downloadImage).toHaveBeenCalledWith("https://example.test/picture.png");
    expectOldPicturePreserved();
    expect(readdirSync(directory)).toEqual(["old.webp"]);
  });
});

describe("studio picture deletion", () => {
  it("preserves the current picture if clearing the database reference fails", async () => {
    updateError = new Error("database unavailable");
    await expect(service.deleteProfilePicture(7)).rejects.toThrow(
      "database unavailable"
    );
    expectOldPicturePreserved();
  });

  it("returns a cleared reference even when file cleanup fails", async () => {
    rmSync(oldPath);
    mkdirSync(oldPath);
    const result = await service.deleteProfilePicture(7);
    expect(result.profile_picture_path).toBeNull();
    expect(studio.profilePicturePath).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("clears the reference before deleting the previous file", async () => {
    const result = await service.deleteProfilePicture(7);
    expect(result.profile_picture_path).toBeNull();
    expect(studio.profilePicturePath).toBeNull();
    expect(existsSync(oldPath)).toBe(false);
  });
});
