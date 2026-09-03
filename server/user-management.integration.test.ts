import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIngestApp } from "./app.js";
import { DurableChunkRepository } from "./durable-repository.js";

test("admin creates, changes and disables a local dashboard user", async () => {
  const repository = await DurableChunkRepository.open(await mkdtemp(join(tmpdir(), "cospec-users-")));
  const app = await createIngestApp({ bearerToken: "viewer", adminBearerToken: "admin", repository, queryRepository: repository });
  try {
    const viewerHeaders = { authorization: "Bearer viewer" };
    const adminHeaders = { authorization: "Bearer admin" };
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/admin/users", headers: viewerHeaders })).statusCode, 403);
    const createdResponse = await app.inject({ method: "POST", url: "/api/v1/admin/users", headers: adminHeaders, payload: { display_name: "运营同事", role: "viewer" } });
    assert.equal(createdResponse.statusCode, 201);
    const created = createdResponse.json();
    assert.match(created.access_token, /^ctu_/);
    assert.equal(created.user.display_name, "运营同事");
    assert.equal(created.user.token_hash, undefined);
    const localHeaders = { authorization: `Bearer ${created.access_token}` };
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: localHeaders })).json().role, "viewer");
    const promoted = await app.inject({ method: "PATCH", url: `/api/v1/admin/users/${created.user.user_id}`, headers: adminHeaders, payload: { role: "admin" } });
    assert.equal(promoted.json().user.role, "admin");
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/admin/users", headers: localHeaders })).statusCode, 200);
    await app.inject({ method: "PATCH", url: `/api/v1/admin/users/${created.user.user_id}`, headers: adminHeaders, payload: { status: "disabled" } });
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: localHeaders })).statusCode, 401);
  } finally { await app.close(); repository.close(); }
});

test("deployment admin wins when viewer and admin tokens are identical", async () => {
  const repository = await DurableChunkRepository.open(await mkdtemp(join(tmpdir(), "cospec-users-token-")));
  const app = await createIngestApp({ bearerToken: "same", adminBearerToken: "same", repository, queryRepository: repository });
  try {
    const me = (await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { authorization: "Bearer same" } })).json();
    assert.equal(me.role, "admin");
  } finally { await app.close(); repository.close(); }
});
