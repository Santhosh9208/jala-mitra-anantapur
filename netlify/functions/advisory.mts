import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// Anantapur, Andhra Pradesh
const LAT = 14.6819;
const LON = 77.6006;

// data.gov.in resource id for the AGMARKNET "Variety-wise Daily Market Prices" dataset
const MANDI_RESOURCE_ID = "9ef84268-d588-465a-a308-a864a43d0070";

const CACHE_MS = 3 * 60 * 60 * 1000; // 3 hours — daily-ish data, no need to hit upstream on every visit

function weatherCodeText(code: number): { en: string; te: string } {
  // WMO weather codes used by Open-Meteo, collapsed into a few farmer-relevant buckets
  if (code === 0) return { en: "Clear", te: "స్పష్టం" };
  if ([1, 2].includes(code)) return { en: "Mostly clear", te: "ఎక్కువగా స్పష్టం" };
  if (code === 3) return { en: "Cloudy", te: "మేఘావృతం" };
  if ([45, 48].includes(code)) return { en: "Foggy", te: "పొగమంచు" };
  if ([51, 53, 55, 56, 57].includes(code)) return { en: "Drizzle", te: "చిరుజల్లులు" };
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return { en: "Rain", te: "వర్షం" };
  if ([95, 96, 99].includes(code)) return { en: "Thunderstorm", te: "ఉరుములు, మెరుపులు" };
  return { en: "Variable", te: "మారుతున్న వాతావరణం" };
}

function pestAdvisory(humidity: number | null, rainChance: number | null, tempC: number | null) {
  const h = humidity ?? 50;
  const r = rainChance ?? 0;
  const t = tempC ?? 30;

  if (h >= 70 && r >= 40) {
    return {
      en: "High humidity and rain chances this week raise leaf-spot and rust risk in groundnut — check the underside of leaves early morning.",
      te: "ఈ వారం అధిక తేమ, వర్ష అవకాశాల వల్ల వేరుశనగలో ఆకుమచ్చ, తుప్పు తెగులు ప్రమాదం పెరుగుతోంది — ఉదయాన్నే ఆకుల అడుగుభాగాన్ని పరిశీలించండి.",
    };
  }
  if (t >= 35 && h < 40) {
    return {
      en: "Hot, dry conditions this week raise the risk of thrips and mites in groundnut — watch for curled or silvery leaves.",
      te: "ఈ వారం వేడి, పొడి వాతావరణం వల్ల వేరుశనగలో తామర పురుగులు, పురుగుల ప్రమాదం పెరుగుతోంది — ముడుచుకున్న లేదా వెండిరంగు ఆకుల కోసం గమనించండి.",
    };
  }
  if (h >= 60) {
    return {
      en: "Moderate humidity this week — keep an eye on early leaf-spot symptoms in groundnut as a precaution.",
      te: "ఈ వారం మధ్యస్థ తేమ ఉంది — జాగ్రత్తగా వేరుశనగలో తొలిదశ ఆకుమచ్చ లక్షణాల కోసం గమనించండి.",
    };
  }
  return {
    en: "No unusual pest risk signalled by this week's weather — continue routine field checks.",
    te: "ఈ వారం వాతావరణం ఆధారంగా అసాధారణ పురుగుల ప్రమాదం ఏదీ కనిపించలేదు — సాధారణ పొలం తనిఖీలు కొనసాగించండి.",
  };
}

function parseDMY(d: string): number {
  // Agmarknet dates come as DD/MM/YYYY
  const parts = String(d || "").split("/");
  if (parts.length !== 3) return 0;
  const [dd, mm, yyyy] = parts.map(Number);
  return new Date(yyyy, mm - 1, dd).getTime();
}

export default async (req: Request, context: Context) => {
  const store = getStore("jala-mitra-advisory");

  const cached = (await store.get("daily", { type: "json" })) as any;
  if (cached && cached.fetchedAt && Date.now() - cached.fetchedAt < CACHE_MS) {
    return new Response(JSON.stringify(cached), {
      headers: { "content-type": "application/json" },
    });
  }

  const result: any = { fetchedAt: Date.now() };

  // --- Weather (Open-Meteo, no key needed) ---
  try {
    const wRes = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&current=temperature_2m,relative_humidity_2m,weather_code&daily=precipitation_probability_max&timezone=Asia%2FKolkata`
    );
    if (!wRes.ok) throw new Error("weather fetch failed");
    const wData = await wRes.json();
    const code = wData?.current?.weather_code;
    const cond = weatherCodeText(code);
    result.weather = {
      tempC: wData?.current?.temperature_2m ?? null,
      humidity: wData?.current?.relative_humidity_2m ?? null,
      rainChance: wData?.daily?.precipitation_probability_max?.[0] ?? null,
      conditionEn: cond.en,
      conditionTe: cond.te,
    };
  } catch {
    result.weather = null;
  }

  // --- Mandi price (Agmarknet via data.gov.in, needs a free API key) ---
  // NOTE: we deliberately don't filter by `market` server-side — Agmarknet's
  // market names often carry a suffix ("Anantapur APMC", "Anantapur(Urban)"
  // etc.) that varies, so an exact filter can silently return nothing. We
  // fetch by state+commodity (values that are consistent) and match the
  // market ourselves.
  const apiKey = process.env.AGMARKNET_API_KEY;
  if (apiKey) {
    try {
      const url =
        `https://api.data.gov.in/resource/${MANDI_RESOURCE_ID}` +
        `?api-key=${encodeURIComponent(apiKey)}&format=json&limit=500` +
        `&filters[state]=${encodeURIComponent("Andhra Pradesh")}` +
        `&filters[commodity]=${encodeURIComponent("Groundnut")}`;
      const pRes = await fetch(url);
      if (!pRes.ok) throw new Error("price fetch failed");
      const pData = await pRes.json();
      const all: any[] = Array.isArray(pData.records) ? pData.records : [];

      // Prefer an exact match on the Anantapur market; fall back to any
      // market name containing "anantapur"; fall back to the whole state.
      let records = all.filter((r) => String(r.market || "").toLowerCase() === "anantapur");
      let scope: "market" | "district" | "state" = "market";
      if (records.length === 0) {
        records = all.filter((r) => String(r.market || "").toLowerCase().includes("anantapur"));
        scope = "market";
      }
      if (records.length === 0) {
        records = all.filter((r) => String(r.district || "").toLowerCase().includes("anantapur"));
        scope = "district";
      }
      if (records.length === 0) {
        records = all;
        scope = "state";
      }

      records.sort((a, b) => parseDMY(b.arrival_date) - parseDMY(a.arrival_date));

      // Collapse multiple markets/varieties reported on the same date into
      // one average per date, so "today" isn't just whichever record
      // happened to sort first.
      const byDate = new Map<string, number[]>();
      records.forEach((r) => {
        if (!r.modal_price) return;
        const key = r.arrival_date;
        if (!byDate.has(key)) byDate.set(key, []);
        byDate.get(key)!.push(Number(r.modal_price));
      });
      const dates = Array.from(byDate.keys()).sort((a, b) => parseDMY(b) - parseDMY(a));
      const avgFor = (d: string) => {
        const vals = byDate.get(d) || [];
        return vals.length ? Math.round(vals.reduce((s, v) => s + v, 0) / vals.length) : null;
      };

      const todayDate = dates[0];
      const yesterdayDate = dates[1];
      const weekDates = dates.slice(0, 7);
      const weekVals = weekDates.map(avgFor).filter((v): v is number => v !== null);
      const weekAvg = weekVals.length ? Math.round(weekVals.reduce((s, v) => s + v, 0) / weekVals.length) : null;

      result.price = todayDate
        ? {
            today: avgFor(todayDate),
            yesterday: yesterdayDate ? avgFor(yesterdayDate) : null,
            weekAvg,
            asOf: todayDate,
            scope, // "market" = Anantapur itself, "district" = Anantapur district, "state" = AP-wide average
          }
        : null;
    } catch {
      result.price = null;
    }
  } else {
    result.price = null;
  }

  // --- Pest advisory: rule-based from live weather signals ---
  result.advisory = result.weather
    ? pestAdvisory(result.weather.humidity, result.weather.rainChance, result.weather.tempC)
    : null;

  await store.setJSON("daily", result);

  return new Response(JSON.stringify(result), {
    headers: { "content-type": "application/json" },
  });
};

export const config: Config = {
  path: "/api/advisory",
};
