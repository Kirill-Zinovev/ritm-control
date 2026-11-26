import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { inflateSync } from "node:zlib";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import {
  assignmentPresentation,
  stockCompletionPresentation,
  supplyWatchPresentation,
  cutMarkReminderPresentation,
  arkadyCardContent,
  arkadyCardCaption,
  arkadyMessageFields,
} from "../worker/cloud/arkadyCards.js";
import {
  renderArkadyCard,
  loadArkadyRenderAssets,
} from "../worker/cloud/arkadyCardImage.js";
import {
  sendBitrixNotification,
  drainBitrixNotifications,
  encryptBitrixConfig,
} from "../worker/cloud/bitrixNotifications.js";

// Real local artwork; all business data, credentials and transports are synthetic.
const book = (area) =>
  `https://docs.google.com/spreadsheets/d/TEST_${area}/edit#gid=7`;
const stockSections = [
  {
    department: "box",
    sheetId: 7,
    articles: 2,
    quantity: 64,
    url: book("box"),
    entries: [
      { article: "PT0001.A0337", quantity: 32 },
      { article: "CT0001.A8111", quantity: 32 },
    ],
  },
  {
    department: "roll",
    sheetId: 8,
    articles: 1,
    quantity: 20,
    url: book("roll"),
    entries: [{ article: "FT0001.A0054", quantity: 20 }],
  },
];
const assignment = (options) =>
  assignmentPresentation({
    kind: "production",
    title: "OZON МОСКВА · Магазин 1",
    manager: "Тест",
    sections: [
      { department: "box", articles: 127, quantity: 5325, url: book("box") },
      { department: "roll", articles: 147, quantity: 5020, url: book("roll") },
    ],
    ...options,
  });
const stockComplete = () =>
  stockCompletionPresentation(
    {
      destination: "urgent",
      manager: "Тест",
      quantity: 84,
      sections: stockSections,
    },
    {
      documentIds: { box: "TEST_box", roll: "TEST_roll" },
      joke: "Список закрыт. Аркадий доволен, станки выдыхают.",
    },
  );
const config = {
  RITM_BITRIX_WEBHOOK_URL: "https://kaleidoskop.bitrix24.ru/rest/1/testsecret/",
  RITM_BITRIX_BOT_ID: "12",
  RITM_BITRIX_BOT_TOKEN: "synthetic-token",
  RITM_BITRIX_BOX_CHAT: "chat2",
  RITM_BITRIX_ROLL_CHAT: "chat2",
};
const assetResponse = (request) => {
  const pathname = new URL(request.url).pathname;
  assert.match(pathname, /^\/images\/arkady-render-assets-v1\.(json|bin)$/);
  return new Response(
    fs.readFileSync(new URL("../public" + pathname, import.meta.url)),
  );
};
function assets() {
  const calls = [];
  return {
    calls,
    fetch: async (request) => {
      calls.push(new URL(request.url).pathname);
      return assetResponse(request);
    },
  };
}
const assetBinding = assets();

function decodePng(png) {
  const buffer = Buffer.from(png);
  assert.equal(buffer.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  const width = buffer.readUInt32BE(16),
    height = buffer.readUInt32BE(20);
  assert.equal(buffer[25], 2);
  const chunks = [];
  let offset = 8;
  while (offset < buffer.length) {
    const size = buffer.readUInt32BE(offset),
      type = buffer.subarray(offset + 4, offset + 8).toString();
    if (type === "IDAT")
      chunks.push(buffer.subarray(offset + 8, offset + 8 + size));
    offset += size + 12;
  }
  const filtered = inflateSync(Buffer.concat(chunks)),
    stride = width * 3,
    pixels = Buffer.alloc(width * height * 3);
  assert.equal(filtered.length, (stride + 1) * height);
  for (let y = 0; y < height; y++) {
    assert.equal(filtered[y * (stride + 1)], 1);
    for (let x = 0; x < stride; x++)
      pixels[y * stride + x] =
        (filtered[y * (stride + 1) + x + 1] +
          (x < 3 ? 0 : pixels[y * stride + x - 3])) &
        255;
  }
  return {
    width,
    height,
    pixel: (x, y) =>
      Array.from(pixels.subarray((y * width + x) * 3, (y * width + x) * 3 + 3)),
  };
}

test("cut mark reminder sends a navy Arkady card with evidence, exact count and one source link", async () => {
  const event = {presentation: cutMarkReminderPresentation({
    name: "OZON Ярославль · Магазин 1",
    department: "roll",
    articleCount: 12,
    articles: ["QA0003.A0788", "QA0003.A0788", "QA0001.A0053", "QA0012.A0458", "QA0007.A0010"],
    url: book("roll"),
  })};
  const result = await renderArkadyCard(event, assetBinding);
  const png = decodePng(result.png);
  assert.equal(png.width, 1000);
  assert.ok(png.height < 650);
  assert.deepEqual(png.pixel(0, 0), [17, 31, 56]);
  assert.deepEqual(png.pixel(0, png.height - 1), [246, 248, 252]);
  assert.notDeepEqual(png.pixel(75, 62), png.pixel(74, 30));
  assert.equal(result.model.heading, "Проверить отметки порезки");
  assert.equal(result.model.status, "Не хватает отметок · 12 артикулов");
  assert.equal(result.model.selection, "QA0003.A0788 · QA0001.A0053 · QA0012.A0458 · ещё 9");
  const words = result.layout.lines.join(" ");
  assert.match(words, /По этим артикулам печать готова и упаковка уже началась/);
  assert.match(words, /OZON Ярославль · Магазин 1/);
  assert.match(words, /Рулонная печать/);
  assert.equal(result.caption, `[URL=${book("roll")}]Открыть лист печати ↗[/URL]`);
  const fallback = arkadyMessageFields(event);
  assert.equal(fallback.ATTACH.BLOCKS.at(-1).GRID[0].LINK, book("roll"));
  assert.equal(fallback.ATTACH.BLOCKS[2].GRID[0].VALUE, result.model.selection);

  const unknownUrl = {presentation: cutMarkReminderPresentation({
    name: "OZON",
    department: "box",
    articleCount: 1,
    articles: ["QA0003.A0788"],
    url: "https://example.invalid/",
  })};
  assert.match(arkadyCardCaption(arkadyCardContent(unknownUrl)), /chatgpt\.site\/\?page=supplies\]Открыть поставки в RITM/);
});

test("every automatic scenario renders the real complete PNG with larger type and prominent subject", async () => {
  const scenarios = [
    assignment(),
    assignment({ action: "append" }),
    assignment({ urgent: true }),
    assignment({
      kind: "stock",
      title: "Запасы склад",
      sections: stockSections,
    }),
    assignment({
      kind: "stock",
      urgent: true,
      title: "Срочные 2 этаж",
      sections: stockSections,
    }),
    stockComplete(),
    supplyWatchPresentation({
      kind: "completion",
      name: "OZON СПБ",
      department: "roll",
      articles: 30,
      quantity: 900,
      url: book("roll"),
    }),
    supplyWatchPresentation({
      kind: "reminder",
      name: "OZON СПБ",
      department: "box",
      articles: 2,
      quantity: 40,
      url: book("box"),
    }),
  ];
  const masks = await loadArkadyRenderAssets(assetBinding);
  for (const presentation of scenarios) {
    const event = { presentation, message: "Legacy", id: "TEST" },
      before = structuredClone(event);
    const result = await renderArkadyCard(event, assetBinding),
      decoded = decodePng(result.png);
    assert.equal(decoded.width, 1000);
    assert.ok(decoded.height >= 450 && decoded.height <= 1400);
    assert.ok(result.png.length > 70000 && result.png.length < 500000);
    assert.equal(result.layout.subjectFontSize, 36);
    assert.ok(result.layout.lines.includes(result.model.subject));
    const links = [...result.caption.matchAll(/\[URL=([^\]]+)\][^\[]+\[\/URL\]/g)];
    assert.deepEqual(links.map(match => match[1]), result.model.sections.filter(section => section.url).map(section => section.url));
    assert.equal(result.caption.replace(/\[URL=[^\]]+\][^\[]+\[\/URL\]/g, '').replaceAll('   ·   ', ''), '');
    assert.ok(
      result.layout.commands
        .filter((row) => row.kind === "text")
        .every(
          (row) =>
            row.x >= 0 && row.x < 1000 && row.y >= 0 && row.y < result.height,
        ),
    );
    for (const row of result.layout.commands.filter(
      (row) => row.kind === "text",
    )) {
      const font = masks.fonts[row.style],
        width = Array.from(row.value).reduce(
          (sum, char) => sum + (font.glyphs[char]?.advance || 0),
          0,
        );
      assert.ok(row.x + width <= 970, `${row.value} overflows`);
    }
    assert.deepEqual(decoded.pixel(5, decoded.height - 5), [255, 255, 255]);
    const subject = result.layout.commands.find(
      (row) => row.kind === "rect" && row.radius === 14,
    );
    assert.deepEqual(
      decoded.pixel(45, subject.y + subject.height - 8),
      presentation.type === "reminder" || presentation.urgent
        ? [255, 241, 217]
        : presentation.type === "completion"
          ? [233, 247, 229]
          : [237, 243, 251],
    );
    assert.deepEqual(event, before);
  }
  assert.equal(
    assetBinding.calls.length,
    2,
    "public assets load once per binding, never per notification",
  );
});

test("stock card keeps exact contents and manager with real links in a compact SAME-message caption", async () => {
  const result = await renderArkadyCard(
    { presentation: stockComplete() },
    assetBinding,
  );
  assert.doesNotMatch(result.caption, /Запасы · Срочные 2 этаж/);
  assert.equal(result.caption.split('\n').length,1);
  assert.equal(result.model.count, 3);
  assert.equal(result.model.quantity, 84);
  for (const article of ["PT0001.A0337", "CT0001.A8111", "FT0001.A0054"])
    assert.ok(result.layout.lines.includes(article));
  assert.ok(result.layout.lines.includes("Добавил(а): Тест"));
  assert.ok(result.caption.length < 400);
  assert.doesNotMatch(result.caption, /Добавил|Аркадий доволен|84 шт\./);
  assert.match(
    result.caption,
    /\[URL=https:\/\/docs.google.com\/spreadsheets\/d\/TEST_box\/edit#gid=7\]/,
  );
  assert.match(result.caption, /TEST_roll\/edit#gid=8/);
  assert.doesNotMatch(
    result.caption,
    /Открыть задание в RITM|упаковка|отгружено/,
  );
  assert.equal(result.layout.hiddenRows, 0);
});

test("ordinary two-department supply uses compact aligned metrics without reducing the approved font sizes",async()=>{
  const result=await renderArkadyCard({presentation:assignment({joke:'Поставка на месте. Станки, держимся: менеджер снова поверил в наши сверхспособности.'})},assetBinding);
  assert.ok(result.height<=720,`supply card grew to ${result.height}px`);
  const commands=result.layout.commands;
  for(const section of result.model.sections){
    const heading=commands.find(row=>row.kind==='text'&&row.value===section.label);
    const count=commands.find(row=>row.kind==='text'&&row.value.includes('артикул')&&row.y===heading.y);
    assert.ok(count,`${section.label} must keep its total on the same row`);
  }
  assert.ok(!result.layout.lines.includes('Задание распределено по участкам'));
  assert.equal(result.layout.subjectFontSize,36);
});

test('a ten-article stock assignment fits entirely in the image with only links below',async()=>{
 const quantities=[160,200,100,200,100,200,200,160,200,160];
 const entries=quantities.map((quantity,index)=>({article:`QA${String(index+1).padStart(4,'0')}.A0001`,quantity}));
 const sections=[['roll',entries.slice(0,3)],['box',entries.slice(3)]].map(([department,items])=>({department,entries:items,articles:items.length,quantity:items.reduce((n,item)=>n+item.quantity,0),url:book(department)}));
 const presentation=assignment({kind:'stock',title:'Запасы склад',manager:'Тест',joke:'Список готов.',sections});
 const result=await renderArkadyCard({presentation},assetBinding);
 assert.equal(result.layout.hiddenRows,0);assert.deepEqual(result.layout.shownRows,[3,7]);
 for(const entry of entries){assert.equal(result.layout.lines.filter(line=>line===entry.article).length,1);assert.ok(!result.caption.includes(entry.article));}
 assert.equal(result.caption.split('\n').length,1);assert.match(result.caption,/TEST_roll/);assert.match(result.caption,/TEST_box/);
 assert.doesNotMatch(result.caption,/1680|1\u00a0680|Добавил|Список готов|Задание на запасы/);
 assert.ok(result.height<1600);
});

test("a failed link-preview cleanup never changes accepted delivery into another message or an uncertain receipt",async()=>{
  const calls=[];
  const result=await sendBitrixNotification({...config,ASSETS:assetBinding},{department:'roll',presentation:stockComplete()},async(url)=>{
    calls.push(url);
    if(url.endsWith('Chat.Message.update'))throw Error('cosmetic timeout');
    return Response.json({result:{messageId:100,file:{id:200},dialogId:'chat2'}});
  });
  assert.equal(result.status,'sent');assert.equal(result.messageId,100);
  assert.equal(calls.filter(url=>url.endsWith('File.upload')).length,1);
  assert.equal(calls.filter(url=>url.endsWith('Chat.Message.update')).length,1);
});

test("500-article batch stays one bounded card with exact totals and only its source link below", async () => {
  const entries = Array.from({ length: 500 }, (_, i) => ({
    article: `PT${String(i).padStart(4, "0")}.A0337`,
    quantity: 32,
  }));
  const card = stockCompletionPresentation(
    {
      destination: "warehouse",
      quantity: 16000,
      sections: [{ department: "box", sheetId: 7, entries }],
    },
    { documentId: "TEST_box" },
  );
  const result = await renderArkadyCard({ presentation: card }, assetBinding);
  assert.equal(result.layout.hiddenRows, 484);
  assert.ok(result.height < 1400);
  assert.equal(result.caption, `[URL=${book('box')}]Бокс ↗[/URL]`);
  assert.equal(result.model.count, 500);
  assert.equal(result.model.quantity, 16000);
  assert.equal(result.model.sections[0].entries.length, 500);
  assert.deepEqual(card.sections[0].entries, entries);
  for (const entry of entries.slice(0, 16)) assert.equal(result.layout.lines.filter(line => line === entry.article).length, 1);
  assert.ok(result.layout.lines.some(row => row.includes("Ещё 484 артикула")));
  assert.ok(result.layout.lines.some(row => row.includes("полный список по ссылке ниже")));
  const visibleTotal = result.layout.commands.filter(row => row.kind === 'text' && row.style === 'total').map(row => row.value).join(' ').replace(/\s+/g, ' ');
  assert.match(visibleTotal, /500 артикулов\s+\|\s+16 000 шт\./);
});

test("long fields never become a text appendix and invalid links cannot inject BBCode", async () => {
  const entries = Array.from({ length: 500 }, (_, i) => ({
    article: "A".repeat(115) + i,
    quantity: 32,
  }));
  const presentation = assignment({
    kind: "stock",
    title: "Срочные 2 этаж",
    sections: [
      {
        department: "box",
        articles: 500,
        quantity: 16000,
        url: book("box"),
        entries,
      },
    ],
  });
  const model = arkadyCardContent({ presentation }),
    caption = arkadyCardCaption(model);
  assert.equal(caption, `[URL=${book('box')}]Бокс ↗[/URL]`);
  assert.equal(model.count, 500);
  assert.equal(model.quantity, 16000);
  assert.equal(model.sections[0].entries.length, 500);
  const malicious = arkadyCardContent({
    presentation: assignment({
      title: "Название [url=javascript:bad] и ещё текст",
      sections: [
        { department: "roll", articles: 2, quantity: 4, url: "javascript:bad" },
      ],
    }),
  });
  assert.equal(malicious.sections[0].url, "");
  assert.equal(arkadyCardCaption(malicious), "");
  assert.doesNotMatch(malicious.subject, /[\[\]]/);
  assert.equal(arkadyCardContent({ message: "historic text" }), null);
});

test("one PNG message keeps clickable links and disables Sheets previews only after its acknowledged delivery", async () => {
  const requests = [];
  const result = await sendBitrixNotification(
    { ...config, ASSETS: assetBinding },
    { id: "new", department: "roll", presentation: stockComplete() },
    async (url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ url, body });
      if(url.endsWith('imbot.v2.Chat.Message.update')){
        assert.equal(requests.length,2);
        assert.equal(body.messageId,100);
        assert.equal(body.fields.urlPreview,'N');
        assert.equal(body.fields.message,requests[0].body.fields.message);
        return Response.json({result:true});
      }
      assert.match(url, /imbot\.v2\.File\.upload$/);
      assert.equal(body.dialogId, "chat2");
      const png = Buffer.from(body.fields.content, "base64");
      assert.equal(decodePng(png).width, 1000);
      assert.match(body.fields.message, /\[URL=/);
      return Response.json({
        result: { messageId: 100, file: { id: 200 }, dialogId: "chat2" },
      });
    },
  );
  assert.equal(requests.length, 2);
  assert.equal(requests.filter(row=>row.url.endsWith('imbot.v2.File.upload')).length,1);
  assert.deepEqual(result, {
    status: "sent",
    messageId: 100,
    fileId: 200,
    format: "card-image-v1",
  });
});

test("missing or mismatched public asset uses one readable native send before any file upload", async () => {
  for (const mode of ["missing", "corrupt"]) {
    const binding = {
      fetch: async (request) =>
        mode === "missing"
          ? new Response(null, { status: 404 })
          : new URL(request.url).pathname.endsWith(".bin")
            ? new Response(new Uint8Array([1, 2, 3]))
            : assetResponse(request),
    };
    const requests = [];
    const result = await sendBitrixNotification(
      { ...config, ASSETS: binding },
      { department: "roll", message: "Legacy", presentation: assignment() },
      async (url, init) => {
        requests.push(url);
        assert.ok(JSON.parse(init.body).ATTACH);
        return Response.json({ result: 1 });
      },
    );
    assert.equal(result.status, "sent");
    assert.equal(requests.length, 1);
    assert.match(requests[0], /imbot\.message\.add$/);
  }
});

test("uncertain file delivery, invalid acknowledgement and HTTP failure never send a native replacement or repeat", async () => {
  for (const failure of ["timeout", "wrong-dialog", "missing-file", "http"]) {
    const values = new Map(),
      operations = new Map(),
      scope = {
        operations,
        meta(key, value) {
          if (arguments.length === 1) return values.get(key);
          values.set(key, value);
        },
        putOperation(kind, value) {
          operations.set(`${kind}:${value.id}`, { kind, value });
        },
        checkpoint: async () => {},
      };
    const bindings = {
      ...config,
      ASSETS: assetBinding,
      RITM_ASSEMBLY_SYNC_SECRET: "a".repeat(64),
    };
    scope.meta(
      "bitrixNotificationConfig",
      await encryptBitrixConfig(bindings, config),
    );
    scope.putOperation("bitrix-notification", {
      id: failure,
      status: "pending",
      department: "roll",
      presentation: assignment(),
      message: "legacy",
    });
    const store = {
      scope: async () => scope,
      withScope: async (callback) => callback(scope),
    };
    let requests = 0;
    const fetcher = async (url) => {
      requests++;
      assert.match(url, /imbot\.v2\.File\.upload$/);
      if (failure === "timeout") throw Error("lost ack");
      if (failure === "http")
        return Response.json({ error: "SERVER_ERROR" }, { status: 500 });
      return Response.json({
        result: {
          messageId: 100,
          file: failure === "missing-file" ? null : { id: 200 },
          dialogId: failure === "wrong-dialog" ? "chat3" : "chat2",
        },
      });
    };
    await drainBitrixNotifications(bindings, store, fetcher);
    await drainBitrixNotifications(bindings, store, fetcher);
    assert.equal(requests, 1);
    assert.equal(
      operations.get(`bitrix-notification:${failure}`).value.status,
      "uncertain",
    );
  }
});

test("acknowledged card receipt survives a store reload without resending or consuming phrases", async () => {
  let values = new Map(),
    operations = new Map();
  const scope = {
    get operations() {
      return operations;
    },
    meta(key, value) {
      if (arguments.length === 1) return values.get(key);
      values.set(key, value);
    },
    putOperation(kind, value) {
      operations.set(`${kind}:${value.id}`, { kind, value });
    },
    checkpoint: async () => {},
  };
  const bindings = {
    ASSETS: assetBinding,
    RITM_ASSEMBLY_SYNC_SECRET: "a".repeat(64),
  };
  scope.meta(
    "bitrixNotificationConfig",
    await encryptBitrixConfig(bindings, config),
  );
  scope.meta("bitrixCompletionPraiseSequenceV2", "101");
  scope.putOperation("bitrix-notification", {
    id: "batch",
    status: "pending",
    department: "roll",
    presentation: stockComplete(),
    message: "legacy",
  });
  const store = {
    scope: async () => scope,
    withScope: async (callback) => callback(scope),
  };
  const recipients = [];
  const fetcher = async (url, init) => {
    if (url.endsWith('Chat.Message.update')) return Response.json({result:true});
    const {dialogId} = JSON.parse(init.body);
    recipients.push(dialogId);
    return Response.json({
      result: { messageId: 100, file: { id: 200 }, dialogId },
    });
  };
  await drainBitrixNotifications(bindings, store, fetcher);
  values = new Map(JSON.parse(JSON.stringify([...values])));
  operations = new Map(JSON.parse(JSON.stringify([...operations])));
  await drainBitrixNotifications(bindings, store, fetcher);
  assert.deepEqual(recipients, ['1698', '2374']);
  const receipt = operations.get("bitrix-notification:batch").value;
  assert.equal(receipt.status, 'sent');
  for (const dialog of recipients) {
    assert.equal(receipt.deliveries[dialog].format, 'card-image-v1');
    assert.equal(receipt.deliveries[dialog].messageId, 100);
    assert.equal(receipt.deliveries[dialog].fileId, 200);
  }
  assert.equal(scope.meta("bitrixCompletionPraiseSequenceV2"), "101");
});

test("actual Worker runtime renders and delivers through the same pipeline with no browser or external rendering", async () => {
  const entry = `import {sendBitrixNotification} from './worker/cloud/bitrixNotifications.js';export default {async fetch(request,env){const input=await request.json();return Response.json(await sendBitrixNotification({...input.config,ASSETS:env.ASSETS},input.event));}}`;
  const result = await build({
    stdin: {
      contents: entry,
      resolveDir: process.cwd(),
      sourcefile: "arkady-test-worker.js",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
  });
  const requests = [];
  const worker = new Miniflare({
    modules: true,
    script: result.outputFiles[0].text,
    compatibilityDate: "2026-08-06",
    serviceBindings: { ASSETS: assetResponse },
    outboundService: async (request) => {
      assert.match(
        request.url,
        /^https:\/\/kaleidoskop\.bitrix24\.ru\/rest\/1\/testsecret\/imbot\.v2\.(?:File\.upload|Chat\.Message\.update)$/,
      );
      requests.push(await request.json());
      return Response.json({
        result: { messageId: 101, file: { id: 201 }, dialogId: "chat2" },
      });
    },
  });
  try {
    const response = await worker.dispatchFetch("https://local.test/", {
      method: "POST",
      body: JSON.stringify({
        config,
        event: { department: "roll", presentation: stockComplete() },
      }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, "sent");
    assert.equal(requests.length, 2);
    assert.equal(
      decodePng(Buffer.from(requests[0].fields.content, "base64")).width,
      1000,
    );
    assert.doesNotMatch(requests[0].fields.message, /Срочные 2 этаж/);
    assert.equal(requests[1].messageId,101);
    assert.equal(requests[1].fields.urlPreview,'N');
  } finally {
    await worker.dispose();
  }
});
