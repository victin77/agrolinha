import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  buildPolygon,
  generatePlan,
  bestDirectionAB,
  type LngLat,
} from "./lib/geometry";
import shp from "shpjs";
import { kml as kmlToGeoJSON } from "@tmcw/togeojson";
import {
  downloadFile,
  buildKML,
  buildISOXML,
  downloadISOXMLZip,
  exportShapefile,
} from "./lib/export";
import {
  loadFazendas,
  saveFazendas,
  type Fazenda,
  type Talhao,
} from "./lib/projects";

// Imagem de satélite gratuita (Esri World Imagery) — sem chave de API
const SAT_STYLE: any = {
  version: 8,
  sources: {
    sat: {
      type: "raster",
      tiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      ],
      tileSize: 256,
      attribution: "Esri, Maxar, Earthstar Geographics",
    },
  },
  layers: [{ id: "sat", type: "raster", source: "sat" }],
};

const EMPTY: any = { type: "FeatureCollection", features: [] };
type Mode = "idle" | "field" | "ab";

export default function App() {
  const mapDiv = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const modeRef = useRef<Mode>("idle");
  const fieldRef = useRef<LngLat[]>([]);
  const abRef = useRef<LngLat[]>([]);
  const closedRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastPlanRef = useRef<any>(null);

  const [mode, setMode] = useState<Mode>("idle");
  const [spacing, setSpacing] = useState(9);
  const [headland, setHeadland] = useState(12);
  const [overlapPct, setOverlapPct] = useState(6);
  const [sacasHa, setSacasHa] = useState(1);
  const [precoSaca, setPrecoSaca] = useState(300);
  const [litrosHa, setLitrosHa] = useState(2.5);
  const [precoLitro, setPrecoLitro] = useState(80);
  const [metrics, setMetrics] = useState<any>(null);
  const [msg, setMsg] = useState("Comece desenhando o talhão.");
  const [fazendas, setFazendas] = useState<Fazenda[]>(() => loadFazendas());
  const [activeFazendaId, setActiveFazendaId] = useState<string | null>(null);
  const [fazNome, setFazNome] = useState("");
  const [talhaoNome, setTalhaoNome] = useState("");
  const spacingRef = useRef(spacing);
  const headlandRef = useRef(headland);
  const previewTsRef = useRef(0);
  const [deleteTarget, setDeleteTarget] = useState<
    { kind: "fazenda" | "talhao"; id: string; nome: string; fazendaId?: string } | null
  >(null);
  const [confirmText, setConfirmText] = useState("");
  const [renameTarget, setRenameTarget] = useState<
    { kind: "fazenda" | "talhao"; id: string; nome: string; fazendaId?: string } | null
  >(null);
  const [renameText, setRenameText] = useState("");

  useEffect(() => {
    if (mapRef.current || !mapDiv.current) return;
    const map = new maplibregl.Map({
      container: mapDiv.current,
      style: SAT_STYLE,
      center: [-54.62, -16.47], // Rondonópolis/MT
      zoom: 13,
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl(), "top-right");

    map.on("load", () => {
      for (const id of ["headland", "field", "swaths", "preview", "ab", "pts"]) {
        map.addSource(id, { type: "geojson", data: EMPTY });
      }
      map.addLayer({
        id: "headland-fill",
        type: "fill",
        source: "headland",
        paint: { "fill-color": "#ff8a3d", "fill-opacity": 0.28 },
      });
      map.addLayer({
        id: "field-fill",
        type: "fill",
        source: "field",
        filter: ["==", "$type", "Polygon"],
        paint: { "fill-color": "#46c46a", "fill-opacity": 0.12 },
      });
      map.addLayer({
        id: "field-line",
        type: "line",
        source: "field",
        paint: { "line-color": "#46c46a", "line-width": 2 },
      });
      map.addLayer({
        id: "swaths-line",
        type: "line",
        source: "swaths",
        paint: { "line-color": "#ffe14a", "line-width": 1.5 },
      });
      map.addLayer({
        id: "preview-line",
        type: "line",
        source: "preview",
        paint: {
          "line-color": "#33c8ff",
          "line-width": 2,
          "line-dasharray": [2, 2],
        },
      });
      map.addLayer({
        id: "ab-line",
        type: "line",
        source: "ab",
        filter: ["==", "$type", "LineString"],
        paint: { "line-color": "#33c8ff", "line-width": 3 },
      });
      map.addLayer({
        id: "pts-circle",
        type: "circle",
        source: "pts",
        paint: {
          "circle-radius": 5,
          "circle-color": "#ffffff",
          "circle-stroke-color": "#222",
          "circle-stroke-width": 2,
        },
      });
    });

    map.on("click", (e) => {
      const ll: LngLat = [e.lngLat.lng, e.lngLat.lat];
      if (modeRef.current === "field") {
        fieldRef.current.push(ll);
        closedRef.current = false;
        drawField();
      } else if (modeRef.current === "ab") {
        if (abRef.current.length >= 2) abRef.current = [];
        abRef.current.push(ll);
        drawAB();
        if (abRef.current.length === 2) {
          setModeBoth("idle");
          setData("preview", EMPTY);
          generate();
        }
      }
    });

    map.on("mousemove", (e) => {
      const ll: LngLat = [e.lngLat.lng, e.lngLat.lat];
      if (modeRef.current === "field" && fieldRef.current.length >= 1) {
        const last = fieldRef.current[fieldRef.current.length - 1];
        setData("preview", lineFeat([last, ll]));
      } else if (modeRef.current === "ab" && abRef.current.length === 1) {
        const a = abRef.current[0];
        setData("preview", lineFeat([a, ll]));
        livePreview(a, ll);
      }
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    spacingRef.current = spacing;
    headlandRef.current = headland;
  }, [spacing, headland]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undoLast();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function src(id: string) {
    return mapRef.current?.getSource(id) as any;
  }
  function setData(id: string, data: any) {
    const s = src(id);
    if (s) s.setData(data);
  }
  function setModeBoth(m: Mode) {
    modeRef.current = m;
    setMode(m);
  }

  function drawField() {
    const pts = fieldRef.current;
    setData("pts", {
      type: "FeatureCollection",
      features: pts.map((p) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: p },
        properties: {},
      })),
    });
    if (closedRef.current && pts.length >= 3) {
      setData("field", {
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [[...pts, pts[0]]] },
        properties: {},
      });
    } else if (pts.length >= 2) {
      setData("field", {
        type: "Feature",
        geometry: { type: "LineString", coordinates: pts },
        properties: {},
      });
    } else {
      setData("field", EMPTY);
    }
  }

  function drawAB() {
    const pts = abRef.current;
    if (pts.length >= 2) {
      setData("ab", {
        type: "Feature",
        geometry: { type: "LineString", coordinates: pts },
        properties: {},
      });
    } else {
      setData("ab", EMPTY);
    }
    setData("pts", {
      type: "FeatureCollection",
      features: [...fieldRef.current, ...pts].map((p) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: p },
        properties: {},
      })),
    });
  }

  function lineFeat(coords: LngLat[]) {
    return {
      type: "Feature",
      geometry: { type: "LineString", coordinates: coords },
      properties: {},
    };
  }

  /** Gera o plano ao vivo enquanto o mouse define o ponto B (com throttle). */
  function livePreview(a: LngLat, b: LngLat) {
    if (!closedRef.current || fieldRef.current.length < 3) return;
    const now = performance.now();
    if (now - previewTsRef.current < 90) return;
    previewTsRef.current = now;
    try {
      const poly = buildPolygon(fieldRef.current);
      const res = generatePlan(poly, a, b, spacingRef.current, headlandRef.current);
      setData("swaths", { type: "FeatureCollection", features: res.swaths });
      setData("headland", res.headlandBand ?? EMPTY);
    } catch {
      /* ignora erros durante o arraste */
    }
  }

  function undoLast() {
    if (modeRef.current === "ab" && abRef.current.length > 0) {
      abRef.current.pop();
      drawAB();
      setData("preview", EMPTY);
      setData("swaths", EMPTY);
      setData("headland", EMPTY);
      setMetrics(null);
      setMsg("Último ponto removido. Marque o B de novo.");
    } else if (fieldRef.current.length > 0) {
      fieldRef.current.pop();
      closedRef.current = false;
      drawField();
      setData("preview", EMPTY);
      setMsg("Último ponto removido.");
    }
  }

  function startField() {
    setModeBoth("field");
    fieldRef.current = [];
    closedRef.current = false;
    setData("swaths", EMPTY);
    setData("headland", EMPTY);
    setData("ab", EMPTY);
    setData("preview", EMPTY);
    abRef.current = [];
    setMetrics(null);
    drawField();
    setMsg("Clique nos cantos do talhão (a linha segue o mouse). Ctrl+Z desfaz.");
  }
  function closeField() {
    if (fieldRef.current.length < 3) {
      setMsg("Marque pelo menos 3 cantos antes de fechar.");
      return;
    }
    closedRef.current = true;
    setModeBoth("idle");
    setData("preview", EMPTY);
    drawField();
    setMsg("Talhão fechado ✔ Agora defina a linha A-B (direção do plantio).");
  }
  function startAB() {
    if (!closedRef.current) {
      setMsg("Feche o talhão primeiro.");
      return;
    }
    setModeBoth("ab");
    abRef.current = [];
    setData("preview", EMPTY);
    drawAB();
    setMsg("Clique no ponto A → mova o mouse e veja as linhas ao vivo → clique no B.");
  }
  function clearAll() {
    fieldRef.current = [];
    abRef.current = [];
    closedRef.current = false;
    setModeBoth("idle");
    for (const id of ["field", "pts", "ab", "swaths", "headland", "preview"])
      setData(id, EMPTY);
    setMetrics(null);
    setMsg("Comece desenhando o talhão.");
  }

  // ---- Fazendas e talhões (localStorage) ----
  function persistFazendas(list: Fazenda[]) {
    setFazendas(list);
    saveFazendas(list);
  }

  function createFazenda() {
    const nome = fazNome.trim();
    if (!nome) {
      setMsg("Dê um nome pra fazenda.");
      return;
    }
    const f: Fazenda = { id: Date.now().toString(36), nome, talhoes: [] };
    persistFazendas([f, ...fazendas]);
    setActiveFazendaId(f.id);
    setFazNome("");
    setMsg(`Fazenda "${nome}" criada. Agora salve talhões nela.`);
  }

  function saveTalhao() {
    if (!closedRef.current || fieldRef.current.length < 3) {
      setMsg("Desenhe ou importe um talhão antes de salvar.");
      return;
    }
    if (!activeFazendaId) {
      setMsg("Selecione (ou crie) uma fazenda primeiro.");
      return;
    }
    const fz = fazendas.find((f) => f.id === activeFazendaId);
    const nome = talhaoNome.trim() || `Talhão ${(fz?.talhoes.length ?? 0) + 1}`;
    const t: Talhao = {
      id: Date.now().toString(36),
      nome,
      field: fieldRef.current,
      ab: abRef.current,
      spacing,
      headland,
      overlapPct,
      sacasHa,
      precoSaca,
      litrosHa,
      precoLitro,
      savedAt: Date.now(),
    };
    persistFazendas(
      fazendas.map((f) =>
        f.id === activeFazendaId ? { ...f, talhoes: [t, ...f.talhoes] } : f
      )
    );
    setTalhaoNome("");
    setMsg(`Talhão "${nome}" salvo ✔`);
  }

  function loadTalhao(t: Talhao) {
    fieldRef.current = t.field;
    abRef.current = t.ab || [];
    closedRef.current = true;
    setSpacing(t.spacing);
    setHeadland(t.headland);
    setOverlapPct(t.overlapPct);
    setSacasHa(t.sacasHa);
    setPrecoSaca(t.precoSaca);
    setLitrosHa(t.litrosHa);
    setPrecoLitro(t.precoLitro);
    setMetrics(null);
    for (const id of ["swaths", "headland", "preview"]) setData(id, EMPTY);
    drawField();
    drawAB();
    const lngs = t.field.map((q) => q[0]);
    const lats = t.field.map((q) => q[1]);
    mapRef.current?.fitBounds(
      [
        [Math.min(...lngs), Math.min(...lats)],
        [Math.max(...lngs), Math.max(...lats)],
      ],
      { padding: 60, duration: 700 }
    );
    setModeBoth("idle");
    setMsg(`"${t.nome}" carregado ✔ Clique em Gerar linhas.`);
  }

  function deleteFazenda(id: string) {
    persistFazendas(fazendas.filter((f) => f.id !== id));
    if (activeFazendaId === id) setActiveFazendaId(null);
  }

  function deleteTalhao(fazendaId: string, talhaoId: string) {
    persistFazendas(
      fazendas.map((f) =>
        f.id === fazendaId
          ? { ...f, talhoes: f.talhoes.filter((t) => t.id !== talhaoId) }
          : f
      )
    );
  }

  function applyRename() {
    if (!renameTarget) return;
    const nome = renameText.trim();
    if (!nome) return;
    if (renameTarget.kind === "fazenda") {
      persistFazendas(
        fazendas.map((f) => (f.id === renameTarget.id ? { ...f, nome } : f))
      );
    } else {
      persistFazendas(
        fazendas.map((f) =>
          f.id === renameTarget.fazendaId
            ? {
                ...f,
                talhoes: f.talhoes.map((t) =>
                  t.id === renameTarget.id ? { ...t, nome } : t
                ),
              }
            : f
        )
      );
    }
    setRenameTarget(null);
    setRenameText("");
    setMsg("Renomeado ✔");
  }

  // ---- Importar talhão de arquivo (KML / GeoJSON / Shapefile .zip) ----
  function firstPolygonRing(geojson: any): LngLat[] | null {
    const features: any[] = [];
    const collect = (g: any) => {
      if (!g) return;
      if (Array.isArray(g)) return g.forEach(collect);
      if (g.type === "FeatureCollection") features.push(...g.features);
      else if (g.type === "Feature") features.push(g);
      else if (g.type === "Polygon" || g.type === "MultiPolygon")
        features.push({ type: "Feature", geometry: g, properties: {} });
    };
    collect(geojson);
    for (const f of features) {
      const geom = f?.geometry;
      if (geom?.type === "Polygon") return geom.coordinates[0];
      if (geom?.type === "MultiPolygon") return geom.coordinates[0][0];
    }
    return null;
  }

  function loadRing(ring: LngLat[]) {
    let pts = ring.map((c: any) => [c[0], c[1]] as LngLat);
    if (pts.length > 1) {
      const a = pts[0];
      const b = pts[pts.length - 1];
      if (a[0] === b[0] && a[1] === b[1]) pts = pts.slice(0, -1);
    }
    if (pts.length < 3) {
      setMsg("Polígono inválido no arquivo (menos de 3 vértices).");
      return;
    }
    fieldRef.current = pts;
    closedRef.current = true;
    abRef.current = [];
    for (const id of ["swaths", "headland", "ab"]) setData(id, EMPTY);
    setMetrics(null);
    setModeBoth("idle");
    drawField();
    const lngs = pts.map((p) => p[0]);
    const lats = pts.map((p) => p[1]);
    mapRef.current?.fitBounds(
      [
        [Math.min(...lngs), Math.min(...lats)],
        [Math.max(...lngs), Math.max(...lats)],
      ],
      { padding: 60, duration: 700 }
    );
    setMsg(`Talhão importado (${pts.length} vértices) ✔ Agora defina a linha A-B.`);
  }

  async function importFromFile(file: File) {
    try {
      setMsg("Importando " + file.name + "...");
      const name = file.name.toLowerCase();
      let geojson: any;
      if (name.endsWith(".geojson") || name.endsWith(".json")) {
        geojson = JSON.parse(await file.text());
      } else if (name.endsWith(".kml")) {
        const dom = new DOMParser().parseFromString(await file.text(), "text/xml");
        geojson = kmlToGeoJSON(dom);
      } else if (name.endsWith(".zip") || name.endsWith(".shp")) {
        geojson = await shp(await file.arrayBuffer());
      } else {
        setMsg("Formato não suportado. Use KML, GeoJSON ou Shapefile (.zip).");
        return;
      }
      const ring = firstPolygonRing(geojson);
      if (!ring) {
        setMsg("Não encontrei um polígono (talhão) no arquivo.");
        return;
      }
      loadRing(ring);
    } catch (err: any) {
      setMsg("Erro ao importar: " + (err?.message || err));
    }
  }

  function generate() {
    if (!closedRef.current || fieldRef.current.length < 3) {
      setMsg("Desenhe e feche o talhão primeiro.");
      return;
    }
    if (abRef.current.length < 2) {
      setMsg("Defina a linha A-B (2 pontos).");
      return;
    }
    try {
      const poly = buildPolygon(fieldRef.current);
      const res = generatePlan(
        poly,
        abRef.current[0],
        abRef.current[1],
        spacingRef.current,
        headlandRef.current
      );
      setData("swaths", { type: "FeatureCollection", features: res.swaths });
      setData("headland", res.headlandBand ?? EMPTY);
      lastPlanRef.current = res;
      const m = res.metrics;
      const diff = m.coberturaHa - m.innerHa; // + = sobreposição, - = falha
      setMetrics({ ...m, diff });
      setMsg(`Plano gerado: ${m.passes} passadas.`);
    } catch (err: any) {
      setMsg("Erro ao gerar: " + (err?.message || err));
    }
  }

  function onExportKML() {
    if (!lastPlanRef.current) {
      setMsg("Gere as linhas primeiro.");
      return;
    }
    const kml = buildKML(fieldRef.current, abRef.current, lastPlanRef.current.swaths);
    downloadFile("agrolinha-talhao.kml", kml, "application/vnd.google-earth.kml+xml");
    setMsg("KML exportado ✔ (abre no Google Earth)");
  }

  function suggestBestDirection() {
    if (!closedRef.current || fieldRef.current.length < 3) {
      setMsg("Desenhe e feche o talhão primeiro.");
      return;
    }
    const [a, b] = bestDirectionAB(fieldRef.current);
    abRef.current = [a, b];
    setModeBoth("idle");
    setData("preview", EMPTY);
    drawAB();
    generate();
    setMsg("Melhor direção aplicada (menos passadas). Ajuste a A-B se quiser.");
  }

  function onExportShapefile() {
    if (!lastPlanRef.current) {
      setMsg("Gere as linhas primeiro.");
      return;
    }
    try {
      exportShapefile(fieldRef.current, lastPlanRef.current.swaths);
      setMsg("Shapefile (.zip) exportado ✔");
    } catch (err: any) {
      setMsg("Erro no Shapefile: " + (err?.message || err));
    }
  }

  async function onExportISOXML() {
    if (!lastPlanRef.current) {
      setMsg("Gere as linhas primeiro.");
      return;
    }
    const areaM2 = (metrics?.areaHa ?? 0) * 10000;
    const xml = buildISOXML(fieldRef.current, abRef.current, areaM2);
    await downloadISOXMLZip("agrolinha-TASKDATA.zip", xml);
    setMsg("ISOXML exportado (.zip) ✔ Suba no isoxml.tools/editor");
  }

  const fmt = (n: number, d = 1) =>
    n.toLocaleString("pt-BR", { maximumFractionDigits: d });

  return (
    <div style={{ position: "relative", height: "100%", width: "100%" }}>
      <div ref={mapDiv} style={{ position: "absolute", inset: 0 }} />

      <div
        style={{
          position: "absolute",
          top: 12,
          left: 12,
          width: 312,
          maxHeight: "calc(100% - 24px)",
          overflowY: "auto",
          background: "rgba(18,20,24,0.92)",
          color: "#eaeaea",
          borderRadius: 12,
          padding: 16,
          boxShadow: "0 8px 30px rgba(0,0,0,0.4)",
          backdropFilter: "blur(4px)",
        }}
      >
        <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 2 }}>
          Agro<span style={{ color: "#ffb24a" }}>Linha</span>
        </div>
        <div style={{ fontSize: 12, color: "#9aa", marginBottom: 14 }}>
          Planejador de linhas · protótipo Fase 1
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept=".kml,.geojson,.json,.zip,.shp"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) importFromFile(f);
            e.target.value = "";
          }}
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          style={{ ...btn(false), marginBottom: 8 }}
        >
          📥 Importar talhão (KML / Shape / GeoJSON)
        </button>
        <div style={{ fontSize: 11, color: "#778", textAlign: "center", margin: "2px 0 8px" }}>
          — ou desenhe na mão —
        </div>

        <div style={{ display: "grid", gap: 8 }}>
          <button onClick={startField} style={btn(mode === "field")}>
            1 · Desenhar talhão
          </button>
          <button onClick={closeField} style={btn(false)}>
            Fechar talhão
          </button>
          <button onClick={startAB} style={btn(mode === "ab")}>
            2 · Definir linha A-B
          </button>
          <button onClick={undoLast} style={btn(false)}>
            ↶ Desfazer último ponto (Ctrl+Z)
          </button>
          <button onClick={suggestBestDirection} style={btn(false)}>
            🧭 Sugerir melhor direção
          </button>
        </div>

        <div style={{ marginTop: 14, display: "grid", gap: 10 }}>
          <Field label="Espaçamento entre passadas (m)">
            <input
              type="number"
              value={spacing}
              min={1}
              step={0.5}
              onChange={(e) => setSpacing(Number(e.target.value))}
              style={inp}
            />
          </Field>
          <Field label="Cabeceira / headland (m)">
            <input
              type="number"
              value={headland}
              min={0}
              step={1}
              onChange={(e) => setHeadland(Number(e.target.value))}
              style={inp}
            />
          </Field>
          <Field label="Sobreposição típica sem planejar (%)">
            <input
              type="number"
              value={overlapPct}
              min={0}
              step={1}
              onChange={(e) => setOverlapPct(Number(e.target.value))}
              style={inp}
            />
          </Field>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <Field label="Semente (sc/ha)">
              <input
                type="number"
                value={sacasHa}
                min={0}
                step={0.1}
                onChange={(e) => setSacasHa(Number(e.target.value))}
                style={inp}
              />
            </Field>
            <Field label="Preço saca (R$)">
              <input
                type="number"
                value={precoSaca}
                min={0}
                step={10}
                onChange={(e) => setPrecoSaca(Number(e.target.value))}
                style={inp}
              />
            </Field>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <Field label="Defensivo (L/ha)">
              <input
                type="number"
                value={litrosHa}
                min={0}
                step={0.5}
                onChange={(e) => setLitrosHa(Number(e.target.value))}
                style={inp}
              />
            </Field>
            <Field label="Preço litro (R$)">
              <input
                type="number"
                value={precoLitro}
                min={0}
                step={5}
                onChange={(e) => setPrecoLitro(Number(e.target.value))}
                style={inp}
              />
            </Field>
          </div>
        </div>

        <button
          onClick={generate}
          style={{
            ...btn(false),
            marginTop: 14,
            background: "#ffb24a",
            color: "#1a1a1a",
            fontWeight: 700,
          }}
        >
          ⚙ Gerar linhas
        </button>
        <button onClick={clearAll} style={{ ...btn(false), marginTop: 8 }}>
          Limpar tudo
        </button>

        {metrics && (
          <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
            <div style={{ fontSize: 12, color: "#9aa" }}>Exportar pro GPS:</div>
            <button onClick={onExportKML} style={btn(false)}>
              ⬇ Exportar KML (visualização)
            </button>
            <button onClick={onExportShapefile} style={btn(false)}>
              ⬇ Exportar Shapefile (.zip)
            </button>
            <button onClick={onExportISOXML} style={btn(false)}>
              ⬇ Exportar ISOXML — linha-guia (beta)
            </button>
          </div>
        )}

        <div style={{ marginTop: 16, borderTop: "1px solid #333", paddingTop: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
            🗂️ Minhas fazendas
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              placeholder="Nome da nova fazenda"
              value={fazNome}
              onChange={(e) => setFazNome(e.target.value)}
              style={{ ...inp, flex: 1 }}
            />
            <button
              onClick={createFazenda}
              style={{ ...btn(false), width: "auto", padding: "7px 12px" }}
            >
              + Fazenda
            </button>
          </div>

          {fazendas.length === 0 ? (
            <div style={{ fontSize: 12, color: "#778", marginTop: 8 }}>
              Nenhuma fazenda ainda. Crie uma acima.
            </div>
          ) : (
            <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
              {fazendas.map((f) => {
                const open = activeFazendaId === f.id;
                return (
                  <div
                    key={f.id}
                    style={{ background: "#1b1e24", borderRadius: 8, overflow: "hidden" }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "7px 9px",
                      }}
                    >
                      <button
                        onClick={() => setActiveFazendaId(open ? null : f.id)}
                        style={{
                          flex: 1,
                          textAlign: "left",
                          background: "none",
                          border: "none",
                          color: "#eaeaea",
                          cursor: "pointer",
                          fontSize: 13.5,
                          fontWeight: 600,
                        }}
                      >
                        {open ? "▾" : "▸"} {f.nome}{" "}
                        <span style={{ color: "#778", fontWeight: 400 }}>
                          ({f.talhoes.length})
                        </span>
                      </button>
                      <button
                        onClick={() => {
                          setRenameTarget({ kind: "fazenda", id: f.id, nome: f.nome });
                          setRenameText(f.nome);
                        }}
                        style={miniBtn}
                      >
                        ✎
                      </button>
                      <button
                        onClick={() => {
                          setDeleteTarget({ kind: "fazenda", id: f.id, nome: f.nome });
                          setConfirmText("");
                        }}
                        style={{ ...miniBtn, color: "#ff7a7a" }}
                      >
                        ✕
                      </button>
                    </div>
                    {open && (
                      <div style={{ padding: "0 9px 9px", display: "grid", gap: 6 }}>
                        {f.talhoes.length === 0 && (
                          <div style={{ fontSize: 12, color: "#778" }}>
                            Sem talhões ainda.
                          </div>
                        )}
                        {f.talhoes.map((t) => (
                          <div
                            key={t.id}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 6,
                              background: "#23262d",
                              borderRadius: 6,
                              padding: "5px 7px",
                            }}
                          >
                            <span
                              style={{
                                flex: 1,
                                fontSize: 12.5,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {t.nome}
                            </span>
                            <button onClick={() => loadTalhao(t)} style={miniBtn}>
                              Abrir
                            </button>
                            <button
                              onClick={() => {
                                setRenameTarget({
                                  kind: "talhao",
                                  id: t.id,
                                  nome: t.nome,
                                  fazendaId: f.id,
                                });
                                setRenameText(t.nome);
                              }}
                              style={miniBtn}
                            >
                              ✎
                            </button>
                            <button
                              onClick={() => {
                                setDeleteTarget({
                                  kind: "talhao",
                                  id: t.id,
                                  nome: t.nome,
                                  fazendaId: f.id,
                                });
                                setConfirmText("");
                              }}
                              style={{ ...miniBtn, color: "#ff7a7a" }}
                            >
                              ✕
                            </button>
                          </div>
                        ))}
                        <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
                          <input
                            placeholder="Nome do talhão"
                            value={talhaoNome}
                            onChange={(e) => setTalhaoNome(e.target.value)}
                            style={{ ...inp, flex: 1, padding: "5px 8px", fontSize: 12.5 }}
                          />
                          <button
                            onClick={saveTalhao}
                            style={{ ...miniBtn, background: "#2c3340" }}
                          >
                            + Salvar atual
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div
          style={{
            marginTop: 12,
            fontSize: 12.5,
            color: "#ffd9a3",
            minHeight: 18,
          }}
        >
          {msg}
        </div>

        {metrics && (
          <div
            style={{
              marginTop: 14,
              borderTop: "1px solid #333",
              paddingTop: 12,
              display: "grid",
              gap: 6,
              fontSize: 13.5,
            }}
          >
            <Row k="Área do talhão" v={`${fmt(metrics.areaHa)} ha`} />
            <Row k="Área útil (sem cabeceira)" v={`${fmt(metrics.innerHa)} ha`} />
            <Row k="Nº de passadas" v={`${metrics.passes}`} />
            <Row k="Comprimento total" v={`${fmt(metrics.totalLenM / 1000, 2)} km`} />
            <Row k="Cobertura estimada" v={`${fmt(metrics.coberturaHa)} ha`} />
            <div
              style={{
                marginTop: 8,
                paddingTop: 10,
                borderTop: "1px dashed #333",
                fontSize: 12,
                color: "#9aa",
              }}
            >
              💰 Economia por safra — evitando ~{overlapPct}% de sobreposição:
            </div>
            {(() => {
              const areaDesp = metrics.innerHa * (overlapPct / 100);
              const sementeSacas = areaDesp * sacasHa;
              const sementeRS = sementeSacas * precoSaca;
              const defL = areaDesp * litrosHa;
              const defRS = defL * precoLitro;
              const totalRS = sementeRS + defRS;
              return (
                <>
                  <Row k="Área poupada" v={`${fmt(areaDesp, 2)} ha`} />
                  <Row
                    k="Semente"
                    v={`${fmt(sementeSacas, 1)} sc · R$ ${fmt(sementeRS, 0)}`}
                  />
                  <Row
                    k="Defensivo"
                    v={`${fmt(defL, 0)} L · R$ ${fmt(defRS, 0)}`}
                  />
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      marginTop: 4,
                      fontSize: 15,
                    }}
                  >
                    <span style={{ color: "#9aa" }}>Total economizado</span>
                    <span style={{ fontWeight: 800, color: "#46c46a" }}>
                      R$ {fmt(totalRS, 0)}
                    </span>
                  </div>
                </>
              );
            })()}
          </div>
        )}
      </div>

      {deleteTarget && (
        <div style={overlayStyle} onClick={() => setDeleteTarget(null)}>
          <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8, color: "#fff" }}>
              ⚠ Excluir {deleteTarget.kind === "fazenda" ? "fazenda" : "talhão"}?
            </div>
            <div style={{ fontSize: 13.5, color: "#bcbcc4", marginBottom: 10, lineHeight: 1.5 }}>
              Essa ação <b>não pode ser desfeita</b>
              {deleteTarget.kind === "fazenda"
                ? " e apaga todos os talhões dela"
                : ""}
              . Para confirmar, digite o nome exatamente:
              <div style={{ marginTop: 6, fontFamily: "monospace", color: "#ff9a6a" }}>
                {deleteTarget.nome}
              </div>
            </div>
            <input
              autoFocus
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="Digite o nome para confirmar"
              style={{ ...inp, marginBottom: 12 }}
            />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                onClick={() => {
                  setDeleteTarget(null);
                  setConfirmText("");
                }}
                style={{ ...btn(false), width: "auto", padding: "8px 14px" }}
              >
                Cancelar
              </button>
              <button
                disabled={confirmText.trim() !== deleteTarget.nome}
                onClick={() => {
                  if (deleteTarget.kind === "fazenda") deleteFazenda(deleteTarget.id);
                  else deleteTalhao(deleteTarget.fazendaId!, deleteTarget.id);
                  setMsg(`"${deleteTarget.nome}" excluído.`);
                  setDeleteTarget(null);
                  setConfirmText("");
                }}
                style={{
                  width: "auto",
                  padding: "8px 16px",
                  borderRadius: 8,
                  border: "none",
                  fontWeight: 700,
                  background:
                    confirmText.trim() === deleteTarget.nome ? "#e5484d" : "#5a2a2c",
                  color:
                    confirmText.trim() === deleteTarget.nome ? "#fff" : "#9a7a7c",
                  cursor:
                    confirmText.trim() === deleteTarget.nome ? "pointer" : "not-allowed",
                }}
              >
                Excluir
              </button>
            </div>
          </div>
        </div>
      )}

      {renameTarget && (
        <div style={overlayStyle} onClick={() => setRenameTarget(null)}>
          <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 10, color: "#fff" }}>
              ✎ Renomear {renameTarget.kind === "fazenda" ? "fazenda" : "talhão"}
            </div>
            <input
              autoFocus
              value={renameText}
              onChange={(e) => setRenameText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && applyRename()}
              style={{ ...inp, marginBottom: 12 }}
            />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                onClick={() => {
                  setRenameTarget(null);
                  setRenameText("");
                }}
                style={{ ...btn(false), width: "auto", padding: "8px 14px" }}
              >
                Cancelar
              </button>
              <button
                disabled={!renameText.trim()}
                onClick={applyRename}
                style={{
                  width: "auto",
                  padding: "8px 16px",
                  borderRadius: 8,
                  border: "none",
                  fontWeight: 700,
                  background: renameText.trim() ? "#ffb24a" : "#5a4a2c",
                  color: renameText.trim() ? "#1a1a1a" : "#9a8a6c",
                  cursor: renameText.trim() ? "pointer" : "not-allowed",
                }}
              >
                Salvar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function btn(active: boolean): React.CSSProperties {
  return {
    width: "100%",
    padding: "9px 12px",
    borderRadius: 8,
    border: "1px solid " + (active ? "#ffb24a" : "#3a3d44"),
    background: active ? "rgba(255,178,74,0.18)" : "#23262d",
    color: "#eaeaea",
    cursor: "pointer",
    fontSize: 13.5,
    textAlign: "left",
  };
}
const inp: React.CSSProperties = {
  width: "100%",
  padding: "7px 9px",
  borderRadius: 7,
  border: "1px solid #3a3d44",
  background: "#1b1e24",
  color: "#fff",
  fontSize: 13.5,
};
const miniBtn: React.CSSProperties = {
  padding: "4px 9px",
  borderRadius: 6,
  border: "1px solid #3a3d44",
  background: "#23262d",
  color: "#eaeaea",
  cursor: "pointer",
  fontSize: 12,
};
const overlayStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  background: "rgba(0,0,0,0.55)",
  display: "grid",
  placeItems: "center",
  zIndex: 50,
  backdropFilter: "blur(2px)",
};
const modalStyle: React.CSSProperties = {
  width: 340,
  maxWidth: "90%",
  background: "#1b1e24",
  border: "1px solid #3a3d44",
  borderRadius: 12,
  padding: 18,
  boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "grid", gap: 4 }}>
      <span style={{ fontSize: 12, color: "#9aa" }}>{label}</span>
      {children}
    </label>
  );
}
function Row({ k, v, warn }: { k: string; v: string; warn?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between" }}>
      <span style={{ color: "#9aa" }}>{k}</span>
      <span style={{ fontWeight: 600, color: warn ? "#ff9a6a" : "#fff" }}>{v}</span>
    </div>
  );
}
