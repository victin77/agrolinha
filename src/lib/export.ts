import type { LngLat } from "./geometry";
import JSZip from "jszip";
import { download as shpDownload } from "@mapbox/shp-write";

/** Exporta Shapefile completo (.shp/.shx/.dbf/.prj) do contorno + linhas, em .zip. */
export function exportShapefile(boundary: LngLat[], swaths: any[]) {
  const features: any[] = [];
  if (boundary.length >= 3) {
    features.push({
      type: "Feature",
      properties: { tipo: "talhao" },
      geometry: { type: "Polygon", coordinates: [[...boundary, boundary[0]]] },
    });
  }
  swaths.forEach((s, i) => {
    features.push({
      type: "Feature",
      properties: { tipo: "linha", n: i + 1 },
      geometry: s.geometry,
    });
  });
  shpDownload(
    { type: "FeatureCollection", features },
    {
      folder: "agrolinha",
      filename: "agrolinha-shapefile",
      outputType: "blob",
      compression: "DEFLATE",
      types: { polygon: "talhao", line: "linhas" },
    }
  );
}

/** Empacota o TASKDATA.XML na estrutura de pasta correta e baixa como .zip. */
export async function downloadISOXMLZip(filename: string, taskdataXml: string) {
  const zip = new JSZip();
  zip.folder("TASKDATA")!.file("TASKDATA.XML", taskdataXml);
  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Dispara o download de um arquivo de texto no navegador. */
export function downloadFile(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const coordStr = (pts: LngLat[]) => pts.map((p) => `${p[0]},${p[1]},0`).join(" ");

/** KML: contorno do talhão + linha A-B + todas as passadas (pra visualizar). */
export function buildKML(
  boundary: LngLat[],
  abLine: LngLat[],
  swaths: any[]
): string {
  const boundaryRing = coordStr([...boundary, boundary[0]]);
  const ab =
    abLine.length >= 2
      ? `<Placemark><name>Linha A-B</name><styleUrl>#ab</styleUrl><LineString><coordinates>${coordStr(
          abLine
        )}</coordinates></LineString></Placemark>`
      : "";
  const lines = swaths
    .map((s, i) => {
      const coords = s.geometry.coordinates
        .map((c: any) => `${c[0]},${c[1]},0`)
        .join(" ");
      return `<Placemark><name>Passada ${
        i + 1
      }</name><styleUrl>#swath</styleUrl><LineString><coordinates>${coords}</coordinates></LineString></Placemark>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>AgroLinha</name>
<Style id="swath"><LineStyle><color>ff4ae1ff</color><width>1.5</width></LineStyle></Style>
<Style id="ab"><LineStyle><color>ffffc833</color><width>3</width></LineStyle></Style>
<Style id="bnd"><LineStyle><color>ff6ac446</color><width>2</width></LineStyle><PolyStyle><fill>0</fill></PolyStyle></Style>
<Placemark><name>Talhao</name><styleUrl>#bnd</styleUrl><Polygon><outerBoundaryIs><LinearRing><coordinates>${boundaryRing}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
${ab}
${lines}
</Document></kml>`;
}

/**
 * ISOXML (ISO 11783-10 v4) — TASKDATA.XML com o talhão (PFD/PLN) e a
 * linha-guia AB (GGP > GPN > LSG). BETA: validar em https://isoxml.tools/editor/
 * e travar os códigos contra um arquivo real do monitor.
 */
export function buildISOXML(
  boundary: LngLat[],
  abLine: LngLat[],
  areaM2: number
): string {
  const bpts = [...boundary, boundary[0]]
    .map((p) => `          <PNT A="10" C="${p[1]}" D="${p[0]}"/>`)
    .join("\n");

  let ggp = "";
  if (abLine.length >= 2) {
    const a = abLine[0];
    const b = abLine[1];
    ggp = `    <GGP A="GGP1" B="Linhas AgroLinha">
      <GPN A="GPN1" B="Linha AB" C="1">
        <LSG A="5">
          <PNT A="6" C="${a[1]}" D="${a[0]}"/>
          <PNT A="7" C="${b[1]}" D="${b[0]}"/>
        </LSG>
      </GPN>
    </GGP>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<ISO11783_TaskData VersionMajor="4" VersionMinor="3" ManagementSoftwareManufacturer="AgroLinha" ManagementSoftwareVersion="0.1" DataTransferOrigin="1">
  <PFD A="PFD1" C="Talhao AgroLinha" D="${Math.round(areaM2)}">
    <PLN A="1" C="Contorno">
      <LSG A="1">
${bpts}
      </LSG>
    </PLN>
${ggp}
  </PFD>
</ISO11783_TaskData>`;
}
