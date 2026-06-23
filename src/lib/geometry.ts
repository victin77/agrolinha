import * as turf from "@turf/turf";

export type LngLat = [number, number];

/** Monta um polígono a partir dos cantos, com obstáculos (furos) opcionais. */
export function buildPolygon(pts: LngLat[], holes: LngLat[][] = []) {
  const rings: LngLat[][] = [[...pts, pts[0]]];
  for (const h of holes) {
    if (h.length >= 3) rings.push([...h, h[0]]);
  }
  return turf.polygon(rings as any);
}

export type PlanMetrics = {
  passes: number;
  areaHa: number;
  innerHa: number;
  totalLenM: number;
  coberturaHa: number;
};

export type PlanResult = {
  swaths: any[];
  headlandBand: any | null;
  metrics: PlanMetrics;
};

/**
 * Gera as linhas de plantio/pulverização paralelas dentro do talhão.
 * - polygon: talhão (lng/lat)
 * - abA, abB: 2 pontos que definem a DIREÇÃO das linhas (linha A-B)
 * - spacingM: espaçamento entre passadas (metros)
 * - headlandM: largura da cabeceira (metros) — recua a borda
 */
export function generatePlan(
  polygon: any,
  abA: LngLat,
  abB: LngLat,
  spacingM: number,
  headlandM: number
): PlanResult {
  // 1) recua o talhão pra criar a cabeceira (headland)
  let inner = polygon;
  if (headlandM > 0) {
    const buf = turf.buffer(polygon, -headlandM, { units: "meters" });
    if (buf) inner = buf;
  }

  // 2) direção das linhas (rumo da A-B) e a perpendicular (pra deslocar)
  const bearing = turf.bearing(turf.point(abA), turf.point(abB));
  const perp = bearing + 90;

  // 3) linha-base longa o suficiente pra atravessar todo o talhão
  const bbox = turf.bbox(polygon);
  const diagKm = turf.distance(
    turf.point([bbox[0], bbox[1]]),
    turf.point([bbox[2], bbox[3]]),
    { units: "kilometers" }
  );
  const mid = turf.midpoint(turf.point(abA), turf.point(abB));
  const p1 = turf.destination(mid, diagKm, bearing, { units: "kilometers" });
  const p2 = turf.destination(mid, diagKm, bearing + 180, { units: "kilometers" });
  const baseLine = turf.lineString([
    p1.geometry.coordinates,
    p2.geometry.coordinates,
  ]);

  // 4) desloca a linha-base de spacing em spacing pros dois lados e recorta no talhão
  const swaths: any[] = [];
  let maxOffsets = Math.ceil((diagKm * 1000) / spacingM) + 2;
  if (maxOffsets > 1500) maxOffsets = 1500; // trava de segurança

  for (let i = -maxOffsets; i <= maxOffsets; i++) {
    const offsetKm = (i * spacingM) / 1000;
    const line =
      i === 0
        ? baseLine
        : turf.transformTranslate(baseLine, offsetKm, perp, {
            units: "kilometers",
          });
    clipLineToPolygon(line, inner).forEach((c) => swaths.push(c));
  }

  // 5) métricas
  const areaHa = turf.area(polygon) / 10000;
  const innerHa = turf.area(inner) / 10000;
  let totalLenM = 0;
  for (const s of swaths) {
    totalLenM += turf.length(s, { units: "kilometers" }) * 1000;
  }
  const coberturaHa = (totalLenM * spacingM) / 10000;

  // 6) faixa da cabeceira (talhão - interior) só pra desenhar
  let headlandBand: any | null = null;
  if (headlandM > 0 && inner !== polygon) {
    try {
      headlandBand = turf.difference(turf.featureCollection([polygon, inner]));
    } catch {
      headlandBand = null;
    }
  }

  return {
    swaths,
    headlandBand,
    metrics: { passes: swaths.length, areaHa, innerHa, totalLenM, coberturaHa },
  };
}

/**
 * Sugere a melhor direção da linha A-B: o rumo que deixa o talhão mais
 * "estreito" na perpendicular = menos passadas e menos manobra na cabeceira.
 * Retorna 2 pontos [A, B] passando pelo centro do talhão.
 */
export function bestDirectionAB(field: LngLat[]): [LngLat, LngLat] {
  const lng0 = field.reduce((a, p) => a + p[0], 0) / field.length;
  const lat0 = field.reduce((a, p) => a + p[1], 0) / field.length;
  const cosLat = Math.cos((lat0 * Math.PI) / 180);
  // projeta vértices num plano local em metros
  const proj = field.map((p) => ({
    xe: (p[0] - lng0) * cosLat * 111320,
    yn: (p[1] - lat0) * 110540,
  }));
  let bestB = 0;
  let bestW = Infinity;
  for (let b = 0; b < 180; b += 2) {
    const r = (b * Math.PI) / 180;
    const px = Math.cos(r);
    const py = -Math.sin(r); // eixo perpendicular ao rumo b
    let mn = Infinity;
    let mx = -Infinity;
    for (const q of proj) {
      const s = q.xe * px + q.yn * py;
      if (s < mn) mn = s;
      if (s > mx) mx = s;
    }
    const w = mx - mn;
    if (w < bestW) {
      bestW = w;
      bestB = b;
    }
  }
  const center = turf.point([lng0, lat0]);
  const A = turf.destination(center, 0.3, bestB + 180, { units: "kilometers" })
    .geometry.coordinates as LngLat;
  const B = turf.destination(center, 0.3, bestB, { units: "kilometers" })
    .geometry.coordinates as LngLat;
  return [A, B];
}

/** Recorta uma linha mantendo só os trechos dentro do polígono. */
function clipLineToPolygon(line: any, polygon: any): any[] {
  try {
    const split = turf.lineSplit(line, polygon);
    const inside: any[] = [];
    for (const seg of split.features) {
      const len = turf.length(seg, { units: "kilometers" });
      if (len === 0) continue;
      const midPt = turf.along(seg, len / 2, { units: "kilometers" });
      if (turf.booleanPointInPolygon(midPt, polygon)) inside.push(seg);
    }
    return inside;
  } catch {
    return [];
  }
}
