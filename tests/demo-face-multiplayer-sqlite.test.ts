import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { rmSync } from "fs";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

process.env.NODE_ENV = "test";
process.env.POSTGRES_USER ||= "demo-face-multiplayer-test";
process.env.POSTGRES_PASSWORD ||= "demo-face-multiplayer-test";
process.env.SESSION_SECRET ||=
  "demo-face-multiplayer-session-secret-at-least-32-characters";
process.env.POSTHOG_API_KEY = "";
process.env.POSTHOG_CAPTURE_REQUEST_METRICS = "false";

const databasePath = `/tmp/conversor-video-demo-face-multiplayer-${process.pid}.sqlite`;

function multipartImage(field = "file"): {
  payload: Buffer;
  headers: Record<string, string>;
} {
  const boundary = "demo-face-boundary";
  const payload = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${field}"; filename="face.jpg"\r\n` +
      "Content-Type: image/jpeg\r\n\r\n" +
      "deterministic-demo-image\r\n" +
      `--${boundary}--\r\n`
  );
  return {
    payload,
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

function nextWebSocketMessage(
  socket: globalThis.WebSocket
): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    socket.addEventListener(
      "message",
      (event) => {
        try {
          resolve(JSON.parse(String(event.data)) as Record<string, any>);
        } catch (error) {
          reject(error);
        }
      },
      { once: true }
    );
    socket.addEventListener("error", (error) => reject(error), { once: true });
  });
}

function waitForWebSocketEvent(
  socket: globalThis.WebSocket,
  event: "open" | "close"
): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.addEventListener(event, () => resolve(), { once: true });
    socket.addEventListener("error", (error) => reject(error), { once: true });
  });
}

describe("SQLite demo face recognition and multiplayer remote contracts", () => {
  const app = Fastify({ logger: false });
  let originalDemoMode: boolean;
  let originalFetch: typeof globalThis.fetch;
  let sqlite: import("bun:sqlite").Database;
  let serverAddress: string;
  let multiplayerRemoteService: typeof import("@/modules/multiplayer-remote/multiplayer-remote.service").multiplayerRemoteService;

  beforeAll(async () => {
    const { env } = await import("@/config/env");
    originalDemoMode = env.DEMO_MODE;
    env.DEMO_MODE = true;

    const demo = await import("@/database/demo");
    demo.setDemoDatabasePathForTests(databasePath);
    for (const path of [
      databasePath,
      `${databasePath}-shm`,
      `${databasePath}-wal`,
    ]) {
      rmSync(path, { force: true });
    }
    demo.importDemoJsonFile(undefined, { reset: true });
    sqlite = demo.getDemoSqlite();

    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("Demo mode attempted an external network request");
    }) as unknown as typeof globalThis.fetch;

    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(multipart);
    await app.register(websocket);
    const { faceRecognitionRoutes } =
      await import("@/modules/face-recognition/face-recognition.routes");
    const { multiplayerRemoteRoutes } =
      await import("@/modules/multiplayer-remote/multiplayer-remote.routes");
    ({ multiplayerRemoteService } =
      await import("@/modules/multiplayer-remote/multiplayer-remote.service"));
    await app.register(faceRecognitionRoutes, { prefix: "/api" });
    await app.register(multiplayerRemoteRoutes, {
      prefix: "/api/multiplayer-remote",
    });
    await app.ready();
    serverAddress = await app.listen({ host: "127.0.0.1", port: 0 });
  });

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    await app.close();
    const demo = await import("@/database/demo");
    demo.closeDemoDatabase();
    demo.setDemoDatabasePathForTests(null);
    for (const path of [
      databasePath,
      `${databasePath}-shm`,
      `${databasePath}-wal`,
    ]) {
      rmSync(path, { force: true });
    }
    const { env } = await import("@/config/env");
    env.DEMO_MODE = originalDemoMode;
  });

  it("serves every face route from SQLite and contained demo assets", async () => {
    const gallery = sqlite
      .query<{ creator_id: number; id: number }, []>(
        `SELECT g.creator_id, g.id
         FROM demo_creator_gallery g
         JOIN demo_creator_face_embeddings e ON e.creator_id = g.creator_id
         ORDER BY g.id LIMIT 1`
      )
      .get();
    expect(gallery).toBeDefined();
    const creatorId = gallery!.creator_id;

    const health = await app.inject({
      method: "GET",
      url: "/api/faces/health",
    });
    expect(health.statusCode, health.body).toBe(200);
    expect(health.json().data).toMatchObject({
      status: "healthy",
      model: "deterministic-demo",
      embedding_dimension: 8,
    });

    const uploadBody = multipartImage();
    const upload = await app.inject({
      method: "POST",
      url: `/api/creators/${creatorId}/face-embeddings`,
      ...uploadBody,
    });
    expect(upload.statusCode, upload.body).toBe(200);
    const uploadedId = upload.json().data.id as number;

    const base64 = await app.inject({
      method: "POST",
      url: `/api/creators/${creatorId}/face-embeddings/base64`,
      payload: { image_base64: Buffer.from("demo-face").toString("base64") },
    });
    expect(base64.statusCode, base64.body).toBe(200);

    const galleryEmbedding = await app.inject({
      method: "POST",
      url: `/api/creators/${creatorId}/face-embeddings/from-gallery/${gallery!.id}`,
    });
    expect(galleryEmbedding.statusCode, galleryEmbedding.body).toBe(200);

    const list = await app.inject({
      method: "GET",
      url: `/api/creators/${creatorId}/face-embeddings`,
    });
    expect(list.statusCode, list.body).toBe(200);
    const embeddings = list.json().data as Array<{
      id: number;
      image_url: string | null;
    }>;
    expect(embeddings.length).toBeGreaterThanOrEqual(3);
    const thumbnailEmbedding = embeddings.find((item) => item.image_url);
    expect(thumbnailEmbedding).toBeDefined();

    const primary = await app.inject({
      method: "PUT",
      url: `/api/creators/${creatorId}/face-embeddings/${uploadedId}/primary`,
    });
    expect(primary.statusCode, primary.body).toBe(200);

    const thumbnail = await app.inject({
      method: "GET",
      url: `/api/creators/${creatorId}/face-embeddings/${thumbnailEmbedding!.id}/thumbnail`,
    });
    expect(thumbnail.statusCode, thumbnail.body).toBe(200);
    expect(thumbnail.headers["content-type"]).toContain("image/");
    expect(thumbnail.rawPayload.byteLength).toBeGreaterThan(0);

    const remove = await app.inject({
      method: "DELETE",
      url: `/api/creators/${creatorId}/face-embeddings/${uploadedId}`,
    });
    expect(remove.statusCode, remove.body).toBe(200);

    const faces = await app.inject({
      method: "GET",
      url: "/api/videos/1/faces",
    });
    expect(faces.statusCode, faces.body).toBe(200);
    const detection = faces.json().data[0] as { id: number };
    expect(detection.id).toBeGreaterThan(0);

    const image = await app.inject({
      method: "GET",
      url: `/api/faces/${detection.id}/image`,
    });
    expect(image.statusCode, image.body).toBe(200);
    expect(image.headers["content-type"]).toContain("image/");
    expect(image.rawPayload.byteLength).toBeGreaterThan(0);

    const extract = await app.inject({
      method: "POST",
      url: "/api/videos/1/faces/extract",
    });
    expect(extract.statusCode, extract.body).toBe(202);

    const status = await app.inject({
      method: "GET",
      url: "/api/videos/1/faces/status",
    });
    expect(status.statusCode, status.body).toBe(200);
    expect(status.json().data.status).toBe("completed");

    const confirm = await app.inject({
      method: "PUT",
      url: `/api/videos/1/faces/${detection.id}/confirm`,
      payload: { creator_id: creatorId },
    });
    expect(confirm.statusCode, confirm.body).toBe(200);

    const byFace = await app.inject({
      method: "GET",
      url: `/api/creators/${creatorId}/videos-by-face`,
    });
    expect(byFace.statusCode, byFace.body).toBe(200);
    expect(byFace.json().data).toEqual(
      expect.arrayContaining([expect.objectContaining({ videoId: 1 })])
    );

    const reject = await app.inject({
      method: "PUT",
      url: `/api/videos/1/faces/${detection.id}/reject`,
    });
    expect(reject.statusCode, reject.body).toBe(200);

    const searchBody = multipartImage();
    const search = await app.inject({
      method: "POST",
      url: "/api/faces/search?threshold=0&limit=5",
      ...searchBody,
    });
    expect(search.statusCode, search.body).toBe(200);
    expect(search.json().data.length).toBeGreaterThan(0);

    const clearQueue = await app.inject({
      method: "DELETE",
      url: "/api/faces/queue",
    });
    expect(clearQueue.statusCode, clearQueue.body).toBe(200);

    const storedKinds = sqlite
      .query<
        { kind: string; count: number },
        []
      >("SELECT kind, count(*) AS count FROM demo_resources WHERE kind LIKE 'face-%' GROUP BY kind ORDER BY kind")
      .all();
    expect(storedKinds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "face-detection" }),
        expect.objectContaining({ kind: "face-embedding" }),
        expect.objectContaining({ kind: "face-extraction-job" }),
        expect.objectContaining({ kind: "face-image" }),
      ])
    );

    const { faceRecognitionDemoService } =
      await import("@/modules/face-recognition/face-recognition.demo.service");
    const storedImage = await faceRecognitionDemoService.getFaceImage(
      detection.id
    );
    const { isDemoAssetPath } = await import("@/database/demo");
    expect(isDemoAssetPath(storedImage.filePath)).toBe(true);
  });

  it("serves every multiplayer route and persists WS-safe state in SQLite", async () => {
    expect(
      app.hasRoute({
        method: "GET",
        url: "/api/multiplayer-remote/ws",
      })
    ).toBe(true);

    const registered = await app.inject({
      method: "POST",
      url: "/api/multiplayer-remote/display-devices",
      payload: { deviceName: "Demo Display", deviceType: "desktop" },
    });
    expect(registered.statusCode, registered.body).toBe(201);
    const registration = registered.json().data as {
      displayDevice: { publicId: string };
      deviceSecret: string;
    };
    expect(registration.displayDevice.publicId).toMatch(
      /^00000000-0000-4000-8000-\d{12}$/
    );
    expect(registration.deviceSecret.length).toBeGreaterThanOrEqual(32);

    const deviceSession =
      await multiplayerRemoteService.bindDisplayDeviceClient({
        deviceId: registration.displayDevice.publicId,
        deviceSecret: registration.deviceSecret,
        clientId: "persistent-display-client",
        userAgent: "demo-test",
      });
    expect(deviceSession.displayClientId).toBe("persistent-display-client");

    const created = await app.inject({
      method: "POST",
      url: "/api/multiplayer-remote/sessions",
    });
    expect(created.statusCode, created.body).toBe(201);
    const session = created.json().data as { id: number; pairingCode: string };
    const displaySocket = new WebSocket(
      `${serverAddress.replace(/^http/, "ws")}/api/multiplayer-remote/ws`
    );
    await waitForWebSocketEvent(displaySocket, "open");
    const connectedMessage = nextWebSocketMessage(displaySocket);
    displaySocket.send(
      JSON.stringify({
        event: "client.hello",
        payload: {
          sessionId: session.id,
          role: "display",
          protocolVersion: 1,
          clientInfo: { clientId: "display-http-contract" },
        },
        timestamp: new Date().toISOString(),
        protocolVersion: 1,
        sessionId: session.id,
      })
    );
    expect(await connectedMessage).toMatchObject({
      event: "client.connected",
      sessionId: session.id,
      payload: {
        role: "display",
        clientId: "display-http-contract",
      },
    });

    const socketSnapshot = {
      sessionId: session.id,
      status: "waiting_for_remote" as const,
      layoutMode: "grid",
      slots: [],
      slotOrder: [],
      activeSlotId: null,
      filters: {},
      updatedAt: "2026-08-01T12:00:00.000Z",
    };
    displaySocket.send(
      JSON.stringify({
        event: "session.state",
        payload: socketSnapshot,
        timestamp: new Date().toISOString(),
        protocolVersion: 1,
        sessionId: session.id,
      })
    );
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const persisted = await multiplayerRemoteService.getSession(
        session.id,
        1
      );
      if (persisted.lastState) break;
      await Bun.sleep(5);
    }
    expect(
      (await multiplayerRemoteService.getSession(session.id, 1)).lastState
    ).toEqual(socketSnapshot);

    const getSession = await app.inject({
      method: "GET",
      url: `/api/multiplayer-remote/sessions/${session.id}`,
    });
    expect(getSession.statusCode, getSession.body).toBe(200);

    const remoteDeviceKey = "demo-remote-device-key-0000000000000001";
    const pair = await app.inject({
      method: "POST",
      url: "/api/multiplayer-remote/pair",
      payload: {
        pairingCode: session.pairingCode,
        remoteDeviceKey,
        remoteDeviceName: "Demo Phone",
        remoteDeviceType: "mobile",
      },
    });
    expect(pair.statusCode, pair.body).toBe(200);
    const firstRequestId = pair.json().data.joinRequest.id as number;

    const pending = await app.inject({
      method: "GET",
      url: `/api/multiplayer-remote/sessions/${session.id}/join-requests/pending`,
    });
    expect(pending.statusCode, pending.body).toBe(200);
    expect(pending.json().data.id).toBe(firstRequestId);

    const rejected = await app.inject({
      method: "POST",
      url: `/api/multiplayer-remote/sessions/${session.id}/join-requests/${firstRequestId}/reject`,
    });
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(rejected.json().data.status).toBe("waiting_for_remote");

    const pairedAgain = await app.inject({
      method: "POST",
      url: "/api/multiplayer-remote/pair",
      payload: {
        pairingCode: session.pairingCode,
        remoteDeviceKey,
        remoteDeviceName: "Demo Phone",
        remoteDeviceType: "mobile",
      },
    });
    expect(pairedAgain.statusCode, pairedAgain.body).toBe(200);
    const secondRequestId = pairedAgain.json().data.joinRequest.id as number;

    const approved = await app.inject({
      method: "POST",
      url: `/api/multiplayer-remote/sessions/${session.id}/join-requests/${secondRequestId}/approve`,
    });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json().data.status).toBe("active");

    const discovery = await app.inject({
      method: "POST",
      url: "/api/multiplayer-remote/trusted-devices/discover",
      payload: { remoteDeviceKey },
    });
    expect(discovery.statusCode, discovery.body).toBe(200);
    expect(discovery.json().data.trustedDevice.deviceName).toBe("Demo Phone");

    const socketClosed = waitForWebSocketEvent(displaySocket, "close");
    displaySocket.close(1000, "contract complete");
    await socketClosed;

    const secondCreated = await app.inject({
      method: "POST",
      url: "/api/multiplayer-remote/sessions",
    });
    const secondSession = secondCreated.json().data as { id: number };
    await multiplayerRemoteService.bindClient({
      sessionId: secondSession.id,
      userId: 1,
      role: "display",
      clientId: "display-state-client",
    });

    const trustedConnect = await app.inject({
      method: "POST",
      url: `/api/multiplayer-remote/sessions/${secondSession.id}/trusted-connect`,
      payload: { remoteDeviceKey },
    });
    expect(trustedConnect.statusCode, trustedConnect.body).toBe(200);
    expect(trustedConnect.json().data.session.status).toBe("active");

    await multiplayerRemoteService.bindClient({
      sessionId: secondSession.id,
      userId: 1,
      role: "remote",
      clientId: "remote-state-client",
    });
    const snapshot = {
      sessionId: secondSession.id,
      status: "active" as const,
      layoutMode: "grid",
      slots: [],
      slotOrder: [],
      activeSlotId: null,
      filters: {},
      updatedAt: "2026-08-01T12:00:00.000Z",
    };
    await multiplayerRemoteService.updateSessionState({
      sessionId: secondSession.id,
      userId: 1,
      clientId: "display-state-client",
      snapshot,
    });
    await multiplayerRemoteService.heartbeatConnection({
      sessionId: secondSession.id,
      role: "remote",
    });
    const rebound = await multiplayerRemoteService.getBoundSession({
      sessionId: secondSession.id,
      userId: 1,
      role: "remote",
      clientId: "remote-state-client",
    });
    expect(rebound.lastState).toEqual(snapshot);
    expect(rebound.remoteLastSeenAt).toBeString();
    expect(
      await multiplayerRemoteService.disconnectClient({
        sessionId: secondSession.id,
        userId: 1,
        role: "remote",
        clientId: "remote-state-client",
      })
    ).toBe(false);

    const close = await app.inject({
      method: "POST",
      url: `/api/multiplayer-remote/sessions/${secondSession.id}/close`,
      payload: { reason: "contract_complete" },
    });
    expect(close.statusCode, close.body).toBe(200);
    expect(
      await multiplayerRemoteService.isSessionClosed(secondSession.id)
    ).toBe(true);

    const storedKinds = sqlite
      .query<
        { kind: string; count: number },
        []
      >("SELECT kind, count(*) AS count FROM demo_resources WHERE kind LIKE 'multiplayer-%' GROUP BY kind ORDER BY kind")
      .all();
    expect(storedKinds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "multiplayer-display-device" }),
        expect.objectContaining({ kind: "multiplayer-join-request" }),
        expect.objectContaining({ kind: "multiplayer-session" }),
        expect.objectContaining({ kind: "multiplayer-trusted-device" }),
      ])
    );
  });
});
