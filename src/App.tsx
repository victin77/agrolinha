import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  buildPolygon,
  generatePlan,
  generateCurvePlan,
  bestDirectionAB,
  overlapRatio,
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
  loadCloudFazendas,
  saveCloudFazendas,
  type Fazenda,
  type Talhao,
} from "./lib/projects";
import { supabase } from "./lib/supabase";

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
type Mode = "idle" | "field" | "ab" | "obstacle" | "curve";
type Layout = "toolbar" | "wizard" | "sections";

// Pontos de encaixe do bottom sheet no celular (fração da altura da tela)
const SHEET_PEEK = 0.14; // só o cabeçalho aparecendo
const SHEET_HALF = 0.5; // metade da tela
const SHEET_FULL = 0.92; // quase tela cheia
const SHEET_SNAPS = [SHEET_PEEK, SHEET_HALF, SHEET_FULL];

export default function App() {
  const mapDiv = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const modeRef = useRef<Mode>("idle");
  const fieldRef = useRef<LngLat[]>([]);
  const abRef = useRef<LngLat[]>([]);
  const closedRef = useRef(false);
  const obstaclesRef = useRef<LngLat[][]>([]);
  const currentObsRef = useRef<LngLat[]>([]);
  const curveRef = useRef<LngLat[]>([]);
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
  const [user, setUser] = useState<any>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [authEmail, setAuthEmail] = useState("");
  const [authPass, setAuthPass] = useState("");
  const [authMode, setAuthMode] = useState<"in" | "up">("in");
  const [authMsg, setAuthMsg] = useState("");
  const [dupConflict, setDupConflict] = useState<
    { novo: Talhao; existingId: string; existingNome: string } | null
  >(null);

  // ---- layout selecionável (V1 toolbar padrão, V2 wizard, V3 seções) ----
  const [layout, setLayout] = useState<Layout>(
    () => (localStorage.getItem("agrolinha:layout") as Layout) || "toolbar"
  );
  const [step, setStep] = useState(0); // wizard
  const [openAcc, setOpenAcc] = useState<Record<number, boolean>>({
    0: true,
    1: false,
    2: true,
    3: false,
  });
  useEffect(() => {
    localStorage.setItem("agrolinha:layout", layout);
  }, [layout]);

  // ---- Bottom sheet arrastável (celular) ----
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 680px)").matches
  );
  const [sheet, setSheet] = useState(SHEET_HALF); // fração da altura da tela
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 680px)");
    const on = () => setIsMobile(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  function onSheetDown(e: React.PointerEvent) {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { startY: e.clientY, startH: sheet };
    setDragging(true);
  }
  function onSheetMove(e: React.PointerEvent) {
    if (!dragRef.current) return;
    const dy = dragRef.current.startY - e.clientY; // arrastar pra cima = positivo
    const h = dragRef.current.startH + dy / window.innerHeight;
    setSheet(Math.max(SHEET_PEEK, Math.min(SHEET_FULL, h)));
  }
  function onSheetUp() {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(false);
    // encaixa no ponto mais próximo
    setSheet((cur) =>
      SHEET_SNAPS.reduce((a, b) => (Math.abs(b - cur) < Math.abs(a - cur) ? b : a))
    );
  }

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
      for (const id of [
        "headland",
        "field",
        "obstacles",
        "swaths",
        "preview",
        "ab",
        "curve",
        "obsdraw",
        "pts",
      ]) {
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
        id: "obstacles-fill",
        type: "fill",
        source: "obstacles",
        paint: { "fill-color": "#e5484d", "fill-opacity": 0.3 },
      });
      map.addLayer({
        id: "obstacles-line",
        type: "line",
        source: "obstacles",
        paint: { "line-color": "#e5484d", "line-width": 2 },
      });
      map.addLayer({
        id: "obsdraw-line",
        type: "line",
        source: "obsdraw",
        filter: ["==", "$type", "LineString"],
        paint: { "line-color": "#ff7a7a", "line-width": 2, "line-dasharray": [2, 2] },
      });
      map.addLayer({
        id: "obsdraw-pts",
        type: "circle",
        source: "obsdraw",
        filter: ["==", "$type", "Point"],
        paint: {
          "circle-radius": 4,
          "circle-color": "#ff7a7a",
          "circle-stroke-color": "#222",
          "circle-stroke-width": 1.5,
        },
      });
      map.addLayer({
        id: "curve-line",
        type: "line",
        source: "curve",
        filter: ["==", "$type", "LineString"],
        paint: { "line-color": "#7ee787", "line-width": 3 },
      });
      map.addLayer({
        id: "curve-pts",
        type: "circle",
        source: "curve",
        filter: ["==", "$type", "Point"],
        paint: {
          "circle-radius": 4,
          "circle-color": "#7ee787",
          "circle-stroke-color": "#222",
          "circle-stroke-width": 1.5,
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
      } else if (modeRef.current === "obstacle") {
        currentObsRef.current.push(ll);
        drawObstacles();
      } else if (modeRef.current === "curve") {
        curveRef.current.push(ll);
        drawCurve();
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
      } else if (
        modeRef.current === "obstacle" &&
        currentObsRef.current.length >= 1
      ) {
        const last = currentObsRef.current[currentObsRef.current.length - 1];
        setData("preview", lineFeat([last, ll]));
      } else if (modeRef.current === "curve" && curveRef.current.length >= 1) {
        const last = curveRef.current[curveRef.current.length - 1];
        setData("preview", lineFeat([last, ll]));
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

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      const u = data.session?.user ?? null;
      setUser(u);
      if (u) syncFromCloud(u.id);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      const u = session?.user ?? null;
      setUser(u);
      if (u) syncFromCloud(u.id);
    });
    return () => sub.subscription.unsubscribe();
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

  function drawObstacles() {
    const committed = obstaclesRef.current
      .filter((o) => o.length >= 3)
      .map((o) => ({
        type: "Feature",
        properties: {},
        geometry: { type: "Polygon", coordinates: [[...o, o[0]]] },
      }));
    setData("obstacles", { type: "FeatureCollection", features: committed });
    const cur = currentObsRef.current;
    const feats: any[] = [];
    if (cur.length >= 2)
      feats.push({
        type: "Feature",
        properties: {},
        geometry: { type: "LineString", coordinates: cur },
      });
    cur.forEach((p) =>
      feats.push({
        type: "Feature",
        properties: {},
        geometry: { type: "Point", coordinates: p },
      })
    );
    setData("obsdraw", { type: "FeatureCollection", features: feats });
  }

  function drawCurve() {
    const cur = curveRef.current;
    const feats: any[] = [];
    if (cur.length >= 2)
      feats.push({
        type: "Feature",
        properties: {},
        geometry: { type: "LineString", coordinates: cur },
      });
    cur.forEach((p) =>
      feats.push({
        type: "Feature",
        properties: {},
        geometry: { type: "Point", coordinates: p },
      })
    );
    setData("curve", { type: "FeatureCollection", features: feats });
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
      const poly = buildPolygon(fieldRef.current, obstaclesRef.current);
      const res = generatePlan(poly, a, b, spacingRef.current, headlandRef.current);
      setData("swaths", { type: "FeatureCollection", features: res.swaths });
      setData("headland", res.headlandBand ?? EMPTY);
    } catch {
      /* ignora erros durante o arraste */
    }
  }

  function undoLast() {
    if (modeRef.current === "obstacle" && currentObsRef.current.length > 0) {
      currentObsRef.current.pop();
      setData("preview", EMPTY);
      drawObstacles();
      setMsg("Ponto do obstáculo removido.");
      return;
    }
    if (modeRef.current === "curve" && curveRef.current.length > 0) {
      curveRef.current.pop();
      setData("preview", EMPTY);
      drawCurve();
      setMsg("Ponto da curva removido.");
      return;
    }
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
    curveRef.current = [];
    setData("curve", EMPTY);
    setData("preview", EMPTY);
    drawAB();
    setMsg("Clique no ponto A → mova o mouse e veja as linhas ao vivo → clique no B.");
  }

  function startCurve() {
    if (!closedRef.current) {
      setMsg("Feche o talhão primeiro.");
      return;
    }
    abRef.current = [];
    setData("ab", EMPTY);
    setModeBoth("curve");
    curveRef.current = [];
    setData("curve", EMPTY);
    setData("preview", EMPTY);
    drawCurve();
    setMsg("Clique pontos seguindo o relevo (a 1ª passada), depois 'Gerar linhas'.");
  }

  function startObstacle() {
    if (!closedRef.current) {
      setMsg("Feche o talhão primeiro.");
      return;
    }
    setModeBoth("obstacle");
    currentObsRef.current = [];
    setData("preview", EMPTY);
    drawObstacles();
    setMsg("Clique em volta do obstáculo (rio/benfeitoria), depois 'Fechar obstáculo'.");
  }

  function closeObstacle() {
    if (currentObsRef.current.length < 3) {
      setMsg("Marque pelo menos 3 pontos no obstáculo.");
      return;
    }
    obstaclesRef.current = [...obstaclesRef.current, currentObsRef.current];
    currentObsRef.current = [];
    setModeBoth("idle");
    setData("preview", EMPTY);
    drawObstacles();
    if (abRef.current.length === 2) generate();
    setMsg("Obstáculo adicionado ✔ As linhas foram recortadas em volta.");
  }
  function clearAll() {
    fieldRef.current = [];
    abRef.current = [];
    obstaclesRef.current = [];
    currentObsRef.current = [];
    curveRef.current = [];
    closedRef.current = false;
    setModeBoth("idle");
    for (const id of [
      "field",
      "pts",
      "ab",
      "swaths",
      "headland",
      "preview",
      "obstacles",
      "obsdraw",
      "curve",
    ])
      setData(id, EMPTY);
    setMetrics(null);
    setMsg("Comece desenhando o talhão.");
  }

  // ---- Fazendas e talhões (localStorage) ----
  function persistFazendas(list: Fazenda[]) {
    setFazendas(list);
    saveFazendas(list);
    if (user) saveCloudFazendas(user.id, list);
  }

  async function syncFromCloud(userId: string) {
    const cloud = await loadCloudFazendas();
    if (cloud && cloud.length > 0) {
      setFazendas(cloud);
      saveFazendas(cloud);
      setMsg("Fazendas carregadas da nuvem ☁");
    } else {
      const local = loadFazendas();
      if (local.length > 0) {
        await saveCloudFazendas(userId, local);
        setMsg("Suas fazendas locais foram salvas na nuvem ☁");
      }
    }
  }

  async function submitAuth() {
    if (!authEmail || authPass.length < 6) {
      setAuthMsg("Informe e-mail e senha (mín. 6 caracteres).");
      return;
    }
    setAuthMsg("Aguarde...");
    const res =
      authMode === "in"
        ? await supabase.auth.signInWithPassword({
            email: authEmail,
            password: authPass,
          })
        : await supabase.auth.signUp({ email: authEmail, password: authPass });
    if (res.error) {
      setAuthMsg(res.error.message);
      return;
    }
    if (authMode === "up" && !res.data.session) {
      setAuthMsg("Conta criada! Confirme pelo e-mail e depois entre.");
      setAuthMode("in");
      return;
    }
    setAuthOpen(false);
    setAuthEmail("");
    setAuthPass("");
    setAuthMsg("");
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
    const novo: Talhao = {
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
    // detecta talhão já existente na mesma área
    const conflito = fz?.talhoes.find(
      (t) => overlapRatio(novo.field, t.field) > 0.3
    );
    if (conflito) {
      setDupConflict({
        novo,
        existingId: conflito.id,
        existingNome: conflito.nome,
      });
      return;
    }
    doSaveTalhao(novo);
  }

  function doSaveTalhao(novo: Talhao) {
    persistFazendas(
      fazendas.map((f) =>
        f.id === activeFazendaId ? { ...f, talhoes: [novo, ...f.talhoes] } : f
      )
    );
    setTalhaoNome("");
    setMsg(`Talhão "${novo.nome}" salvo ✔`);
  }

  function updateExistingTalhao(novo: Talhao, existingId: string) {
    persistFazendas(
      fazendas.map((f) =>
        f.id === activeFazendaId
          ? {
              ...f,
              talhoes: f.talhoes.map((t) =>
                t.id === existingId ? { ...novo, id: existingId } : t
              ),
            }
          : f
      )
    );
    setTalhaoNome("");
    setMsg("Talhão atualizado ✔");
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
    setModeBoth("idle");
    setData("preview", EMPTY);
    const poly = buildPolygon(fieldRef.current, obstaclesRef.current);
    try {
      let res;
      if (curveRef.current.length >= 2) {
        res = generateCurvePlan(
          poly,
          curveRef.current,
          spacingRef.current,
          headlandRef.current
        );
      } else if (abRef.current.length >= 2) {
        res = generatePlan(
          poly,
          abRef.current[0],
          abRef.current[1],
          spacingRef.current,
          headlandRef.current
        );
      } else {
        setMsg("Defina a linha A-B (reta) ou desenhe uma linha curva.");
        return;
      }
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
    curveRef.current = [];
    setData("curve", EMPTY);
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

  // ===================== BLOCOS REUTILIZÁVEIS DA VIEW =====================

  const fileInput = (
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
  );

  const header = (
    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
      <div>
        <div className="logo">
          Agro<b>Linha</b>
        </div>
        <div className="sub">Planejamento de linhas de plantio</div>
      </div>
      <div className="layout-switch">
        <button className={layout === "toolbar" ? "on" : ""} title="Toolbar flutuante" onClick={() => setLayout("toolbar")}>
          ⬚
        </button>
        <button className={layout === "wizard" ? "on" : ""} title="Passo a passo" onClick={() => setLayout("wizard")}>
          ⇢
        </button>
        <button className={layout === "sections" ? "on" : ""} title="Seções" onClick={() => setLayout("sections")}>
          ≣
        </button>
      </div>
    </div>
  );

  const authRow = (
    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 10 }}>
      {user ? (
        <>
          <span
            style={{
              fontSize: 11.5,
              color: "var(--green-strong)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            ☁ {user.email}
          </span>
          <button className="mini" style={{ marginLeft: "auto" }} onClick={() => supabase.auth.signOut()}>
            Sair
          </button>
        </>
      ) : (
        <button
          className="btn center"
          onClick={() => {
            setAuthOpen(true);
            setAuthMsg("");
          }}
        >
          ☁ Entrar / criar conta (salvar na nuvem)
        </button>
      )}
    </div>
  );

  const spacingHeadland = (
    <>
      <label className="field">
        <span>Espaçamento entre passadas (m)</span>
        <input className="inp" type="number" value={spacing} min={1} step={0.5} onChange={(e) => setSpacing(Number(e.target.value))} />
      </label>
      <label className="field">
        <span>Cabeceira / headland (m)</span>
        <input className="inp" type="number" value={headland} min={0} step={1} onChange={(e) => setHeadland(Number(e.target.value))} />
      </label>
    </>
  );

  const economyInputs = (
    <>
      <label className="field">
        <span>Sobreposição típica sem planejar (%)</span>
        <input className="inp" type="number" value={overlapPct} min={0} step={1} onChange={(e) => setOverlapPct(Number(e.target.value))} />
      </label>
      <div className="grid2">
        <label className="field">
          <span>Semente (sc/ha)</span>
          <input className="inp" type="number" value={sacasHa} min={0} step={0.1} onChange={(e) => setSacasHa(Number(e.target.value))} />
        </label>
        <label className="field">
          <span>Preço saca (R$)</span>
          <input className="inp" type="number" value={precoSaca} min={0} step={10} onChange={(e) => setPrecoSaca(Number(e.target.value))} />
        </label>
      </div>
      <div className="grid2">
        <label className="field">
          <span>Defensivo (L/ha)</span>
          <input className="inp" type="number" value={litrosHa} min={0} step={0.5} onChange={(e) => setLitrosHa(Number(e.target.value))} />
        </label>
        <label className="field">
          <span>Preço litro (R$)</span>
          <input className="inp" type="number" value={precoLitro} min={0} step={5} onChange={(e) => setPrecoLitro(Number(e.target.value))} />
        </label>
      </div>
    </>
  );

  const paramsForm = (
    <div style={{ display: "grid", gap: 10 }}>
      {spacingHeadland}
      {economyInputs}
    </div>
  );

  const generateBtn = (
    <button className="btn btn-primary" style={{ marginTop: 6 }} onClick={generate}>
      ⚙ Gerar linhas
    </button>
  );

  // grupo de ferramentas com rótulo (wizard e seções)
  const fieldGroup = (
    <>
      <button className="btn" onClick={() => fileInputRef.current?.click()}>
        <span className="ic">📥</span> Importar (KML / Shape / GeoJSON)
      </button>
      <div className="grid2">
        <button className={"btn center" + (mode === "field" ? " active" : "")} onClick={startField}>
          ▱ Desenhar
        </button>
        <button className="btn center" onClick={closeField}>
          ✓ Fechar
        </button>
      </div>
      <button className={"btn" + (mode === "ab" ? " active" : "")} onClick={startAB}>
        <span className="ic">⟋</span> Definir linha A-B
      </button>
      <button className="btn" onClick={suggestBestDirection}>
        <span className="ic">🧭</span> Sugerir melhor direção
      </button>
    </>
  );

  const advancedGroup = (
    <>
      <button className={"btn" + (mode === "curve" ? " active" : "")} onClick={startCurve}>
        <span className="ic">〰</span> Linha curva / relevo
      </button>
      <div className="grid2">
        <button className={"btn center" + (mode === "obstacle" ? " active" : "")} onClick={startObstacle}>
          ⛒ Obstáculo
        </button>
        <button className="btn center" onClick={closeObstacle}>
          ✓ Fechar obst.
        </button>
      </div>
      <button className="btn" onClick={undoLast}>
        <span className="ic">↶</span> Desfazer ponto (Ctrl+Z)
      </button>
    </>
  );

  const resultBlock = metrics && (
    <div style={{ display: "grid", gap: 6 }}>
      <div className="row">
        <span className="k">Área do talhão</span>
        <span className="v">{fmt(metrics.areaHa)} ha</span>
      </div>
      <div className="row">
        <span className="k">Área útil (sem cabeceira)</span>
        <span className="v">{fmt(metrics.innerHa)} ha</span>
      </div>
      <div className="row">
        <span className="k">Nº de passadas</span>
        <span className="v">{metrics.passes}</span>
      </div>
      <div className="row">
        <span className="k">Comprimento total</span>
        <span className="v">{fmt(metrics.totalLenM / 1000, 2)} km</span>
      </div>
      <div className="row">
        <span className="k">Cobertura estimada</span>
        <span className="v">{fmt(metrics.coberturaHa)} ha</span>
      </div>
      <div className="econ">
        <div className="head">💰 Economia por safra — evitando ~{overlapPct}% de sobreposição</div>
        {(() => {
          const areaDesp = metrics.innerHa * (overlapPct / 100);
          const sementeSacas = areaDesp * sacasHa;
          const sementeRS = sementeSacas * precoSaca;
          const defL = areaDesp * litrosHa;
          const defRS = defL * precoLitro;
          const totalRS = sementeRS + defRS;
          return (
            <>
              <div className="row">
                <span className="k">Área poupada</span>
                <span className="v">{fmt(areaDesp, 2)} ha</span>
              </div>
              <div className="row">
                <span className="k">Semente</span>
                <span className="v">
                  {fmt(sementeSacas, 1)} sc · R$ {fmt(sementeRS, 0)}
                </span>
              </div>
              <div className="row">
                <span className="k">Defensivo</span>
                <span className="v">
                  {fmt(defL, 0)} L · R$ {fmt(defRS, 0)}
                </span>
              </div>
              <div className="total">
                <span className="k">Total economizado</span>
                <b>R$ {fmt(totalRS, 0)}</b>
              </div>
            </>
          );
        })()}
      </div>
    </div>
  );

  const exportBlock = metrics && (
    <div style={{ display: "grid", gap: 8 }}>
      <button className="btn" onClick={onExportKML}>
        <span className="ic">⬇</span> KML (visualização)
      </button>
      <button className="btn" onClick={onExportShapefile}>
        <span className="ic">⬇</span> Shapefile (.zip)
      </button>
      <button className="btn" onClick={onExportISOXML}>
        <span className="ic">⬇</span> ISOXML — linha-guia (beta)
      </button>
    </div>
  );

  const fazendasBlock = (
    <>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          className="inp"
          style={{ flex: 1 }}
          placeholder="Nome da nova fazenda"
          value={fazNome}
          onChange={(e) => setFazNome(e.target.value)}
        />
        <button className="mini" onClick={createFazenda}>
          + Fazenda
        </button>
      </div>
      {fazendas.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 8 }}>
          Nenhuma fazenda ainda. Crie uma acima.
        </div>
      ) : (
        <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
          {fazendas.map((f) => {
            const open = activeFazendaId === f.id;
            return (
              <div key={f.id} className="faz">
                <div className="faz-h">
                  <button className="toggle" onClick={() => setActiveFazendaId(open ? null : f.id)}>
                    {open ? "▾" : "▸"} {f.nome}{" "}
                    <span style={{ color: "var(--muted)", fontWeight: 400 }}>({f.talhoes.length})</span>
                  </button>
                  <button
                    className="mini"
                    onClick={() => {
                      setRenameTarget({ kind: "fazenda", id: f.id, nome: f.nome });
                      setRenameText(f.nome);
                    }}
                  >
                    ✎
                  </button>
                  <button
                    className="mini danger"
                    onClick={() => {
                      setDeleteTarget({ kind: "fazenda", id: f.id, nome: f.nome });
                      setConfirmText("");
                    }}
                  >
                    ✕
                  </button>
                </div>
                {open && (
                  <div style={{ padding: "0 9px 9px", display: "grid", gap: 6 }}>
                    {f.talhoes.length === 0 && (
                      <div style={{ fontSize: 12, color: "var(--muted)" }}>Sem talhões ainda.</div>
                    )}
                    {f.talhoes.map((t) => (
                      <div key={t.id} className="tal">
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
                        <button className="mini" onClick={() => loadTalhao(t)}>
                          Abrir
                        </button>
                        <button
                          className="mini"
                          onClick={() => {
                            setRenameTarget({ kind: "talhao", id: t.id, nome: t.nome, fazendaId: f.id });
                            setRenameText(t.nome);
                          }}
                        >
                          ✎
                        </button>
                        <button
                          className="mini danger"
                          onClick={() => {
                            setDeleteTarget({ kind: "talhao", id: t.id, nome: t.nome, fazendaId: f.id });
                            setConfirmText("");
                          }}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                    <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
                      <input
                        className="inp"
                        style={{ flex: 1, padding: "5px 8px", fontSize: 12.5 }}
                        placeholder="Nome do talhão"
                        value={talhaoNome}
                        onChange={(e) => setTalhaoNome(e.target.value)}
                      />
                      <button className="mini" onClick={saveTalhao}>
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
    </>
  );

  // toolbar flutuante (V1)
  const toolbarEl = layout === "toolbar" && !isMobile && (
    <div className="toolbar" style={{ left: 368 }}>
      <button data-tip="Importar talhão" onClick={() => fileInputRef.current?.click()}>
        📥
      </button>
      <button data-tip="Desenhar talhão" className={mode === "field" ? "on" : ""} onClick={startField}>
        ▱
      </button>
      <button data-tip="Fechar talhão" onClick={closeField}>
        ✓
      </button>
      <button data-tip="Linha A-B" className={mode === "ab" ? "on" : ""} onClick={startAB}>
        ⟋
      </button>
      <button data-tip="Melhor direção" onClick={suggestBestDirection}>
        🧭
      </button>
      <button data-tip="Linha curva / relevo" className={mode === "curve" ? "on" : ""} onClick={startCurve}>
        〰
      </button>
      <button data-tip="Obstáculo" className={mode === "obstacle" ? "on" : ""} onClick={startObstacle}>
        ⛒
      </button>
      <button data-tip="Fechar obstáculo" onClick={closeObstacle}>
        ▣
      </button>
      <div className="sep" />
      <button data-tip="Desfazer (Ctrl+Z)" onClick={undoLast}>
        ↶
      </button>
      <button data-tip="Limpar tudo" onClick={clearAll}>
        🗑
      </button>
    </div>
  );

  function accSection(idx: number, n: string, title: string, body: React.ReactNode) {
    const open = openAcc[idx];
    return (
      <div className="acc">
        <div className="acc-h" onClick={() => setOpenAcc((s) => ({ ...s, [idx]: !s[idx] }))}>
          <span className="n">{n}</span> {title} <span className="chev">{open ? "▾" : "▸"}</span>
        </div>
        {open && <div className="acc-b">{body}</div>}
      </div>
    );
  }

  // ===================== ARRANJOS POR LAYOUT =====================

  let panelContent: React.ReactNode;

  if (layout === "toolbar") {
    panelContent = (
      <>
        {fileInput}
        {header}
        {authRow}
        {isMobile && (
          <>
            <div className="lbl">Ferramentas</div>
            <div style={{ display: "grid", gap: 8 }}>
              {fieldGroup}
              {advancedGroup}
            </div>
          </>
        )}
        <div className="lbl">Parâmetros & economia</div>
        {paramsForm}
        {generateBtn}
        <button className="btn center" style={{ marginTop: 8 }} onClick={clearAll}>
          Limpar tudo
        </button>
        {metrics && (
          <>
            <div className="lbl">Resultado</div>
            {resultBlock}
          </>
        )}
        {metrics && (
          <>
            <div className="lbl">Exportar pro GPS</div>
            {exportBlock}
          </>
        )}
        <div className="lbl">Minhas fazendas</div>
        {fazendasBlock}
        <div className="msg">{msg}</div>
      </>
    );
  } else if (layout === "wizard") {
    const stepper = (
      <div className="steps">
        <div className="step">
          <div className={"dot" + (step === 0 ? " on" : step > 0 ? " done" : "")}>{step > 0 ? "✓" : "1"}</div>
          <div className={"stitle " + (step === 0 ? "on" : "off")}>Talhão</div>
        </div>
        <div className={"stepbar" + (step >= 1 ? " done" : "")} />
        <div className="step">
          <div className={"dot" + (step === 1 ? " on" : step > 1 ? " done" : "")}>{step > 1 ? "✓" : "2"}</div>
          <div className={"stitle " + (step === 1 ? "on" : "off")}>Linha</div>
        </div>
        <div className={"stepbar" + (step >= 2 ? " done" : "")} />
        <div className="step">
          <div className={"dot" + (step === 2 ? " on" : "")}>3</div>
          <div className={"stitle " + (step === 2 ? "on" : "off")}>Plano</div>
        </div>
      </div>
    );
    panelContent = (
      <>
        {fileInput}
        {header}
        {authRow}
        {stepper}
        <div className="divider" />
        {step === 0 && (
          <>
            <div className="lbl">Passo 1 · Desenhe ou importe o talhão</div>
            <div style={{ display: "grid", gap: 8 }}>{fieldGroup}</div>
          </>
        )}
        {step === 1 && (
          <>
            <div className="lbl">Passo 2 · Direção do plantio</div>
            <div style={{ display: "grid", gap: 8, marginBottom: 10 }}>
              <button className={"btn" + (mode === "ab" ? " active" : "")} onClick={startAB}>
                <span className="ic">⟋</span> Definir linha A-B na mão
              </button>
              <button className="btn" onClick={suggestBestDirection}>
                <span className="ic">🧭</span> Sugerir melhor direção
              </button>
              <button className={"btn" + (mode === "curve" ? " active" : "")} onClick={startCurve}>
                <span className="ic">〰</span> Linha curva / relevo
              </button>
            </div>
            <div style={{ display: "grid", gap: 10 }}>{spacingHeadland}</div>
          </>
        )}
        {step === 2 && (
          <>
            <div className="lbl">Passo 3 · Economia & plano</div>
            <div style={{ display: "grid", gap: 10 }}>{economyInputs}</div>
            {generateBtn}
            {metrics && <div style={{ marginTop: 12 }}>{resultBlock}</div>}
            {metrics && (
              <>
                <div className="lbl">Exportar pro GPS</div>
                {exportBlock}
              </>
            )}
          </>
        )}
        <div className="nav">
          {step > 0 && (
            <button className="btn center" style={{ flex: 0.6 }} onClick={() => setStep(step - 1)}>
              ← Voltar
            </button>
          )}
          {step < 2 ? (
            <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => setStep(step + 1)}>
              Avançar →
            </button>
          ) : (
            <button className="btn btn-primary" style={{ flex: 1 }} onClick={generate}>
              ⚙ Gerar linhas
            </button>
          )}
        </div>
        <div className="msg">{msg}</div>
        <div className="divider" />
        <div className="lbl">Minhas fazendas</div>
        {fazendasBlock}
      </>
    );
  } else {
    // sections (V3)
    panelContent = (
      <>
        {fileInput}
        {header}
        {authRow}
        {accSection(0, "1", "Talhão", <div style={{ display: "grid", gap: 8 }}>{fieldGroup}</div>)}
        {accSection(1, "2", "Avançado", <div style={{ display: "grid", gap: 8 }}>{advancedGroup}</div>)}
        {accSection(
          2,
          "3",
          "Parâmetros & economia",
          <>
            {paramsForm}
            {generateBtn}
            {metrics && <div style={{ marginTop: 12 }}>{resultBlock}</div>}
            {metrics && (
              <>
                <div className="lbl" style={{ marginTop: 12 }}>
                  Exportar pro GPS
                </div>
                {exportBlock}
              </>
            )}
          </>
        )}
        {accSection(3, "4", "Minhas fazendas", fazendasBlock)}
        <button className="btn center" style={{ marginTop: 10 }} onClick={clearAll}>
          Limpar tudo
        </button>
        <div className="msg">{msg}</div>
      </>
    );
  }

  // ===================== RENDER =====================

  return (
    <div style={{ position: "relative", height: "100%", width: "100%" }}>
      <div ref={mapDiv} style={{ position: "absolute", inset: 0 }} />

      {toolbarEl}
      <div
        className={"panel" + (isMobile ? " sheet" : "") + (dragging ? " dragging" : "")}
        style={isMobile ? { height: `${sheet * 100}vh` } : undefined}
      >
        {isMobile && (
          <div
            className="sheet-handle"
            onPointerDown={onSheetDown}
            onPointerMove={onSheetMove}
            onPointerUp={onSheetUp}
            onPointerCancel={onSheetUp}
          >
            <div className="grip" />
          </div>
        )}
        {panelContent}
      </div>

      {deleteTarget && (
        <div className="overlay" onClick={() => setDeleteTarget(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>⚠ Excluir {deleteTarget.kind === "fazenda" ? "fazenda" : "talhão"}?</h3>
            <p>
              Essa ação <b>não pode ser desfeita</b>
              {deleteTarget.kind === "fazenda" ? " e apaga todos os talhões dela" : ""}. Para confirmar, digite o nome
              exatamente:
              <span style={{ display: "block", marginTop: 6, fontFamily: "monospace", color: "var(--amber)" }}>
                {deleteTarget.nome}
              </span>
            </p>
            <input
              className="inp"
              autoFocus
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="Digite o nome para confirmar"
              style={{ marginBottom: 12 }}
            />
            <div className="modal-actions">
              <button
                className="btn center"
                style={{ width: "auto", padding: "8px 14px" }}
                onClick={() => {
                  setDeleteTarget(null);
                  setConfirmText("");
                }}
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
                  borderRadius: 10,
                  border: "none",
                  fontWeight: 700,
                  background: confirmText.trim() === deleteTarget.nome ? "var(--danger)" : "#EAD7D5",
                  color: confirmText.trim() === deleteTarget.nome ? "#fff" : "#B79A98",
                  cursor: confirmText.trim() === deleteTarget.nome ? "pointer" : "not-allowed",
                }}
              >
                Excluir
              </button>
            </div>
          </div>
        </div>
      )}

      {renameTarget && (
        <div className="overlay" onClick={() => setRenameTarget(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>✎ Renomear {renameTarget.kind === "fazenda" ? "fazenda" : "talhão"}</h3>
            <input
              className="inp"
              autoFocus
              value={renameText}
              onChange={(e) => setRenameText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && applyRename()}
              style={{ marginBottom: 12 }}
            />
            <div className="modal-actions">
              <button
                className="btn center"
                style={{ width: "auto", padding: "8px 14px" }}
                onClick={() => {
                  setRenameTarget(null);
                  setRenameText("");
                }}
              >
                Cancelar
              </button>
              <button
                className="btn btn-primary"
                style={{ width: "auto", padding: "8px 16px" }}
                disabled={!renameText.trim()}
                onClick={applyRename}
              >
                Salvar
              </button>
            </div>
          </div>
        </div>
      )}

      {authOpen && (
        <div className="overlay" onClick={() => setAuthOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>☁ {authMode === "in" ? "Entrar na nuvem" : "Criar conta"}</h3>
            <p>Salve suas fazendas e acesse de qualquer dispositivo.</p>
            <input
              className="inp"
              placeholder="seu@email.com"
              value={authEmail}
              onChange={(e) => setAuthEmail(e.target.value)}
              style={{ marginBottom: 8 }}
            />
            <input
              className="inp"
              type="password"
              placeholder="senha (mín. 6)"
              value={authPass}
              onChange={(e) => setAuthPass(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitAuth()}
              style={{ marginBottom: 8 }}
            />
            {authMsg && <div style={{ fontSize: 12, color: "var(--amber)", marginBottom: 8 }}>{authMsg}</div>}
            <div style={{ display: "flex", gap: 8, justifyContent: "space-between", alignItems: "center" }}>
              <button className="mini" onClick={() => setAuthMode(authMode === "in" ? "up" : "in")}>
                {authMode === "in" ? "Criar conta" : "Já tenho conta"}
              </button>
              <button className="btn btn-primary" style={{ width: "auto", padding: "8px 18px" }} onClick={submitAuth}>
                {authMode === "in" ? "Entrar" : "Criar"}
              </button>
            </div>
          </div>
        </div>
      )}

      {dupConflict && (
        <div className="overlay" onClick={() => setDupConflict(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>⚠ Opa, já existe um talhão aqui!</h3>
            <p>
              O talhão <b style={{ color: "var(--amber)" }}>{dupConflict.existingNome}</b> já ocupa essa mesma área.
              Você não pode ter dois talhões no mesmo lugar.
            </p>
            <div style={{ display: "grid", gap: 8 }}>
              <button
                className="btn btn-primary"
                onClick={() => {
                  updateExistingTalhao(dupConflict.novo, dupConflict.existingId);
                  setDupConflict(null);
                }}
              >
                Atualizar "{dupConflict.existingNome}" com este desenho
              </button>
              <button
                className="btn center"
                onClick={() => {
                  doSaveTalhao(dupConflict.novo);
                  setDupConflict(null);
                }}
              >
                Salvar como novo mesmo assim
              </button>
              <button className="btn center" onClick={() => setDupConflict(null)}>
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
