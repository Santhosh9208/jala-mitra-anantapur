import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const ALLOWED_STATUS = ["ok", "warn", "bad"];

function clean(str: unknown, max = 200): string {
  return String(str ?? "").trim().slice(0, max);
}

// Strip the owner token before sending entries to the browser —
// it must never be visible to anyone but the person who created the entry.
function publicView(entry: any) {
  const { ownerToken, ...rest } = entry;
  return rest;
}

export default async (req: Request, context: Context) => {
  const store = getStore("jala-mitra-board");

  if (req.method === "GET") {
    const list = (await store.get("entries", { type: "json" })) || [];
    return new Response(JSON.stringify(list.map(publicView)), {
      headers: { "content-type": "application/json" },
    });
  }

  if (req.method === "POST") {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    const village = clean(body?.village);
    const point = clean(body?.point);
    const name = clean(body?.name);
    const status = ALLOWED_STATUS.includes(body?.status) ? body.status : "ok";

    if (!village || !point || !name) {
      return new Response(JSON.stringify({ error: "Missing fields" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    const list = (await store.get("entries", { type: "json" })) || [];
    const ownerToken = crypto.randomUUID();
    const entry = {
      id: Date.now(),
      village,
      point,
      status,
      name,
      time: new Date().toISOString(),
      ownerToken,
    };
    list.push(entry);
    await store.setJSON("entries", list);

    // Only this one response includes the token — the creator's browser
    // saves it locally so it can prove ownership later when deleting.
    return new Response(JSON.stringify({ ...publicView(entry), ownerToken }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  }

  if (req.method === "DELETE") {
    const url = new URL(req.url);
    const id = Number(url.searchParams.get("id"));
    const token = url.searchParams.get("token") || "";

    const list = (await store.get("entries", { type: "json" })) || [];
    const target = list.find((e: any) => e.id === id);

    if (!target) {
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    if (!token || target.ownerToken !== token) {
      return new Response(JSON.stringify({ error: "Not authorized to delete this entry" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }

    const next = list.filter((e: any) => e.id !== id);
    await store.setJSON("entries", next);
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
    });
  }

  return new Response("Method not allowed", { status: 405 });
};

export const config: Config = {
  path: "/api/board",
};
