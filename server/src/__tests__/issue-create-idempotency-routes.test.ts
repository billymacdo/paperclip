import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, companyMemberships, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import type { StorageService } from "../storage/types.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping issue idempotency route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("POST /companies/:companyId/issues — idempotency key", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentId!: string;
  let runId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-idempotency-");
    db = createDb(tempDb.connectionString);

    companyId = randomUUID();
    agentId = randomUUID();
    runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Idempotency Test Corp",
      issuePrefix: "IDP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "board-user",
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status: "running",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      contextSnapshot: {},
    });
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function makeStorage(): StorageService {
    return {
      provider: "local_disk",
      putFile: vi.fn(async () => { throw new Error("unexpected putFile"); }),
      getObject: vi.fn(async () => { throw new Error("unexpected getObject"); }),
      headObject: vi.fn(async () => ({ exists: false })),
      deleteObject: vi.fn(async () => undefined),
    };
  }

  function makeApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "agent",
        agentId,
        companyId,
        runId,
        source: "agent_jwt",
      } as Express.Request["actor"];
      next();
    });
    app.use("/api", issueRoutes(db, makeStorage()));
    app.use(errorHandler);
    return app;
  }

  async function countIssuesByKey(idempotencyKey: string) {
    const rows = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.idempotencyKey, idempotencyKey));
    return rows.length;
  }

  // ---- Happy path ----

  it("returns 201 on first create with an idempotency key", async () => {
    const app = makeApp();
    const key = `agent-1:run-1:${randomUUID()}`;

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: `idempotency-first-${randomUUID()}`, priority: "medium", idempotencyKey: key });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.headers["x-paperclip-deduplicated"]).toBeUndefined();
    expect(res.body.idempotencyKey).toBe(key);
  });

  it("returns 200 with the original issue on duplicate key within TTL", async () => {
    const app = makeApp();
    const key = `agent-1:run-1:${randomUUID()}`;
    const title = `idempotency-dedup-${randomUUID()}`;

    const r1 = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title, priority: "medium", idempotencyKey: key });
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);

    const r2 = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: `different-title-${randomUUID()}`, priority: "medium", idempotencyKey: key });

    expect(r2.status, JSON.stringify(r2.body)).toBe(200);
    expect(r2.body.id).toBe(r1.body.id);
    expect(r2.headers["x-paperclip-deduplicated"]).toBe("true");
  });

  it("creates exactly one DB row when the same key is POSTed twice", async () => {
    const app = makeApp();
    const key = `agent-1:run-1:${randomUUID()}`;

    await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: `key-one-row-a-${randomUUID()}`, priority: "medium", idempotencyKey: key });
    await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: `key-one-row-b-${randomUUID()}`, priority: "medium", idempotencyKey: key });

    expect(await countIssuesByKey(key)).toBe(1);
  });

  // ---- Different keys create separate issues ----

  it("creates two issues when different idempotency keys are used", async () => {
    const app = makeApp();
    const title = `diff-keys-${randomUUID()}`;

    const r1 = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title, priority: "medium", idempotencyKey: `key-a:${randomUUID()}` });
    const r2 = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title, priority: "medium", idempotencyKey: `key-b:${randomUUID()}` });

    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r1.body.id).not.toBe(r2.body.id);
    expect(r2.headers["x-paperclip-deduplicated"]).toBeUndefined();
  });

  // ---- No key = no dedup ----

  it("does NOT dedup when idempotencyKey is omitted", async () => {
    const app = makeApp();
    const title = `no-key-${randomUUID()}`;

    const r1 = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title, priority: "medium" });
    const r2 = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title, priority: "medium" });

    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r1.body.id).not.toBe(r2.body.id);
    expect(r2.headers["x-paperclip-deduplicated"]).toBeUndefined();
  });

  // ---- TTL expiry ----

  it("creates a new issue when the same key is used after the TTL expires", async () => {
    const app = makeApp();
    const key = `ttl-expired-key:${randomUUID()}`;

    // Insert an issue with this key but a createdAt beyond the 5-minute TTL
    const oldIssueId = randomUUID();
    await db.insert(issues).values({
      id: oldIssueId,
      companyId,
      title: "Old issue before TTL",
      status: "todo",
      priority: "medium",
      idempotencyKey: key,
      createdAt: new Date(Date.now() - 6 * 60_000), // 6 minutes ago — past the 5-min TTL
      updatedAt: new Date(),
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: `after-ttl-${randomUUID()}`, priority: "medium", idempotencyKey: key });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.id).not.toBe(oldIssueId);
    expect(res.headers["x-paperclip-deduplicated"]).toBeUndefined();
    expect(await countIssuesByKey(key)).toBe(2);
  });
});
