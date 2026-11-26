import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { arkadyWbIntake, arkadyWbIntakeMaxBytes } from "../worker/cloud/arkadyWbIntake.js";
import { cloudApi } from "../worker/cloud/runtime.js";
import { bindings as syntheticSources } from "./cloud-env.mjs";

const path = "/api/ritm/arkady/catalog/wb-intake";
const publicPath = "/api/arkady/catalog/wb-intake";
const site = "https://assembly-v2.zinovevkirill234.chatgpt.site";
const secret = "a".repeat(64);
const bindings = { RITM_ASSEMBLY_V2_TARGET_URL: site, RITM_ASSEMBLY_V2_FEED_SECRET: secret };
const principal = { id: "owner", role: "owner" };
const options = { bindings, principal, writesEnabled: true };
const draft = { article: "WA0001.A0002", barcode: "0000000091923", store: "1", name: "Наклейка", packaging: "С клапаном" };
const fingerprint = "b".repeat(64);
const approvalId = "b7618251-b59e-479f-b153-349543f16a8d";
const png = {
  filename: "товар.png", mimeType: "image/png",
  content: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB9sAAAAASUVORK5CYII=",
};
function pngChunk(kind, content) {
  const size = Buffer.alloc(4), crc = Buffer.alloc(4);
  size.writeUInt32BE(content.length);
  const image = Buffer.concat([Buffer.from(kind), content]);
  crc.writeUInt32BE(crc32(image));
  return Buffer.concat([size, image, crc]);
}
const width = 696, height = 480;
const dimensions = Buffer.alloc(13);
dimensions.writeUInt32BE(width);
dimensions.writeUInt32BE(height, 4);
dimensions[8] = 8;
const label = {
  filename: "этикетка.png", mimeType: "image/png",
  content: Buffer.concat([
    Buffer.from(png.content, "base64").subarray(0, 8),
    pngChunk("IHDR", dimensions),
    pngChunk("IDAT", deflateSync(Buffer.alloc((width + 1) * height))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]).toString("base64"),
};
const prepare = { action: "prepare", draft };
const confirm = { action: "confirm", draft, fingerprint, approvalId, explicitWriteApproval: true };
const preview = { ok: true, mode: "create", draft, fingerprint, missing: [], hasPhoto: false, hasLabel: false, source: "input" };

function signed(url, request) {
  assert.equal(url, site + path);
  const { headers, body } = request;
  const signature = createHmac("sha256", secret).update(JSON.stringify([
    1, "POST", path, headers["x-assembly-v2-at"], headers["x-assembly-v2-nonce"],
    createHash("sha256").update(body).digest("hex"),
  ])).digest("hex");
  assert.equal(headers["x-assembly-v2-signature"], signature);
  return JSON.parse(body);
}

test("prepare signs only scoped WB fields without media or write credentials, preserving leading zeros", async () => {
  const result = await arkadyWbIntake({
    ...prepare, approvedBy: "forged", approvalId, market: "OZON",
    draft: { ...draft, label: png, photo: png, barcode: " " + draft.barcode + " " },
  }, {
    ...options,
    principal: { id: "manager", role: "manager" },
    fetcher: async (url, req) => {
      assert.deepEqual(signed(url, req), prepare);
      return Response.json({ ...preview, draft: { ...draft, confidential: "discard" }, internal: "discard" });
    },
  });
  assert.deepEqual(result, { ...preview, canEdit: false });
});

test("only an explicit owner approval forwards real media and the stable request identity", async () => {
  let writes = 0;
  const fetcher = async (url, req) => {
    writes++;
    assert.deepEqual(signed(url, req), {
      action: "confirm", draft: { ...draft, photo: png, label },
      fingerprint, approvalId, approvedBy: principal.id,
    });
    return Response.json({ ok: true, entryId: "WB:test", revision: 2, internal: "discard" });
  };
  await assert.rejects(arkadyWbIntake(confirm, { ...options, principal: { role: "manager" }, fetcher }), { status: 403 });
  await assert.rejects(arkadyWbIntake(confirm, { ...options, writesEnabled: false, fetcher }), { status: 403 });
  await assert.rejects(arkadyWbIntake({ ...confirm, explicitWriteApproval: false }, { ...options, fetcher }), { status: 409 });
  await assert.rejects(arkadyWbIntake({ ...confirm, fingerprint: "invalid" }, { ...options, fetcher }), { status: 409 });
  await assert.rejects(arkadyWbIntake({ ...confirm, draft: { ...draft, label: { ...png, content: "PGh0bWw+" } } }, { ...options, fetcher }), { status: 400 });
  await assert.rejects(arkadyWbIntake({ ...confirm, draft: { ...draft, label: png } }, { ...options, fetcher }), { status: 400 });
  await assert.rejects(arkadyWbIntake({ ...confirm, draft: { ...draft, label: { ...png, filename: "../test.png" } } }, { ...options, fetcher }), { status: 400 });
  const bytes = Buffer.concat([Buffer.from(png.content, "base64"), Buffer.alloc(200_000)]);
  await assert.rejects(arkadyWbIntake({ ...confirm, draft: { ...draft, label: { ...png, content: bytes.toString("base64") } } }, { ...options, fetcher }), { status: 400 });
  assert.equal(writes, 0);
  const input = { ...confirm, approvedBy: "forged", draft: { ...draft, photo: png, label } };
  assert.deepEqual(await arkadyWbIntake(input, { ...options, fetcher }), { ok: true, entryId: "WB:test", revision: 2 });
  assert.equal(writes, 1);
});

test("response scope mismatch and a lost confirmation never turn into success or an automatic re-send", async () => {
  await assert.rejects(arkadyWbIntake(prepare, { ...options, fetcher: async () =>
    Response.json({ ...preview, draft: { ...draft, store: "2" } }) }), { status: 503 });
  await assert.rejects(arkadyWbIntake(prepare, { ...options, fetcher: async () =>
    Response.json({ ok: false }, { status: 409 }) }), { status: 409 });
  const message = "У этого артикула уже указан другой штрихкод. Сверьте карточку магазина.";
  await assert.rejects(arkadyWbIntake(prepare, { ...options, fetcher: async () =>
    Response.json({ error: message }, { status: 409 }) }), { status: 409, message });
  let calls = 0;
  await assert.rejects(arkadyWbIntake(confirm, { ...options, fetcher: async () => {
    calls++;
    throw Error("lost acknowledgement");
  } }), { status: 503 });
  assert.equal(calls, 1);
});

test("Main cloud route registers WB intake and rejects cross-origin or oversize uploads before forwarding", async () => {
  const unexpectedDatabaseCall = () => assert.fail("WB intake should use the signed Assembly service.");
  const env = {
    ...syntheticSources, ...bindings, DB: { prepare: unexpectedDatabaseCall, batch: unexpectedDatabaseCall },
    RITM_OWNER_USER_IDS: "owner", RITM_GOOGLE_READER_JSON: "{}",
    RITM_CLOUD_WRITES_ENABLED: "true", RITM_CLOUD_CUTOVER_ID: "test",
  };
  const req = (input, origin = "https://ritm.test") => new Request("https://ritm.test" + publicPath, {
    method: "POST",
    headers: { origin, "oai-authenticated-user-id": "owner", "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  let calls = 0;
  const fetcher = async (url, req) => {
    calls++;
    assert.deepEqual(signed(url, req), prepare);
    return Response.json(preview);
  };
  assert.equal((await cloudApi(req(prepare, "https://other.test"), env, {}, { fetcher })).status, 403);
  assert.equal((await cloudApi(req({ ...prepare, padding: "a".repeat(arkadyWbIntakeMaxBytes) }), env, {}, { fetcher })).status, 413);
  const result = await cloudApi(req(prepare), env, {}, { fetcher });
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { ...preview, canEdit: true });
  assert.equal(calls, 1);
});
