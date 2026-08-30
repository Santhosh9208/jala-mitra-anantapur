import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

function clean(str: unknown, max = 500): string {
  return String(str ?? "").trim().slice(0, max);
}

export default async (req: Request, context: Context) => {
  const store = getStore("jala-mitra-reports");

  if (req.method === "GET") {
    const list = (await store.get("entries", { type: "json" })) || [];
    return new Response(JSON.stringify(list), {
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

    const desc = clean(body?.desc);
    const type = clean(body?.type, 100);
    const who = clean(body?.who, 200);

    if (!desc) {
      return new Response(JSON.stringify({ error: "Missing description" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    const list = (await store.get("entries", { type: "json" })) || [];
    const entry = {
      id: Date.now(),
      type,
      desc,
      who,
      time: new Date().toISOString(),
    };
    list.push(entry);
    await store.setJSON("entries", list);

    return new Response(JSON.stringify(entry), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  }

  return new Response("Method not allowed", { status: 405 });
};

export const config: Config = {
  path: "/api/reports",
};
