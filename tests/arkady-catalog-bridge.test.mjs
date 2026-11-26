import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { arkadyCatalog } from "../worker/cloud/arkadyCatalog.js";

const secret = "1".repeat(64);
const origin = "https://assembly-v2.zinovevkirill234.chatgpt.site";
const path = "/api/ritm/arkady-catalog";
const owner = { id: "test-owner", role: "owner" };
const manager = { id: "test-manager", role: "manager" };
const read = { action: "read", market: "WB", article: "TEST.A0001" };
const apply = {
  ...read, action: "apply", store: "1", id: "product-1", importId: "batch-1",
  revision: 0, field: "packingNorm", value: "15,5", explicitWriteApproval: true,
};
const options = {
  bindings: { RITM_ASSEMBLY_V2_TARGET_URL: origin, RITM_ASSEMBLY_V2_FEED_SECRET: secret },
  principal: owner,
  writesEnabled: true,
};

test("catalog reads sign only the exact requested marketplace and article", async () => {
  const result = await arkadyCatalog({ ...read, approvedBy: "user-supplied" }, {
    ...options,
    principal: manager,
    fetcher: async (url, request) => {
      assert.equal(url, origin + path);
      assert.deepEqual(JSON.parse(request.body), read);
      const { headers, body } = request;
      const signature = createHmac("sha256", secret).update(JSON.stringify([
        1, "POST", path, headers["x-assembly-v2-at"], headers["x-assembly-v2-nonce"],
        createHash("sha256").update(body).digest("hex"),
      ])).digest("hex");
      assert.equal(headers["x-assembly-v2-signature"], signature);
      return Response.json({ ok: true, entries: [], fieldOptions: { machine: ["2-GO"] } });
    },
  });
  assert.equal(result.canEdit, false);
  assert.deepEqual(result.fieldOptions.machine, ["2-GO"]);
});

test("only direct owner confirmation signs a single catalog field change", async () => {
  let writes = 0;
  const fetcher = async (_url, request) => {
    writes++;
    const payload = JSON.parse(request.body);
    assert.equal(payload.approvedBy, owner.id);
    assert.match(payload.approvalId, /^[a-f0-9-]{36}$/);
    assert.equal(payload.value, 15.5);
    assert.equal(payload.field, "packingNorm");
    assert.equal(payload.revision, apply.revision);
    assert.equal(payload.quantity, undefined);
    return Response.json({ ok: true });
  };
  for (const principal of [null, manager]) {
    await assert.rejects(arkadyCatalog(apply, { ...options, principal, fetcher }), { status: 403 });
  }
  await assert.rejects(arkadyCatalog(apply, { ...options, writesEnabled: false, fetcher }), { status: 403 });
  await assert.rejects(arkadyCatalog({ ...apply, explicitWriteApproval: false }, { ...options, fetcher }), { status: 409 });
  await assert.rejects(arkadyCatalog({ ...apply, field: "article" }, { ...options, fetcher }), { status: 400 });
  assert.equal(writes, 0);
  assert.deepEqual(await arkadyCatalog({
    ...apply, approvedBy: "forged", quantity: 500,
  }, { ...options, fetcher }), { ok: true });
  assert.equal(writes, 1);
});

test("a stale catalog revision and an uncertain write are reported without retry", async () => {
  let requests = 0;
  const fetcher = async () => {
    requests++;
    return Response.json({ ok: false }, { status: 409 });
  };
  await assert.rejects(arkadyCatalog(apply, { ...options, fetcher }), { status: 409 });
  await assert.rejects(arkadyCatalog(apply, {
    ...options,
    fetcher: async () => { requests++; throw new Error("lost acknowledgement"); },
  }), { status: 503 });
  assert.equal(requests, 2);
});
