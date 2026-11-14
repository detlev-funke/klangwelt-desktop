// Kleine MusicXML-Stücke als Testbibliothek (werden zur Laufzeit geschrieben).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STEPS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** "C4:1" → <note> (Dauer in Vierteln; divisions = 2). "R:1" = Pause. */
function noteXml(spec) {
  const [name, durS = "1"] = spec.split(":");
  const dur = Math.round(Number(durS) * 2);
  const type = { 1: "eighth", 2: "quarter", 3: "quarter", 4: "half", 6: "half", 8: "whole" }[dur] ?? "quarter";
  if (name === "R") return `<note><rest/><duration>${dur}</duration><type>${type}</type></note>`;
  const m = name.match(/^([A-G])(#|b)?(\d)$/);
  if (!m) throw new Error(`Note? ${spec}`);
  const alter = m[2] === "#" ? "<alter>1</alter>" : m[2] === "b" ? "<alter>-1</alter>" : "";
  return `<note><pitch><step>${m[1]}</step>${alter}<octave>${m[3]}</octave></pitch><duration>${dur}</duration><type>${type}</type></note>`;
}

/** Noten (Dauer in Vierteln) auf Takte zu `beats` Vierteln verteilen. */
function measures(notes, beats) {
  const out = [];
  let cur = [];
  let fill = 0;
  for (const n of notes) {
    cur.push(n);
    fill += Number(n.split(":")[1] ?? 1);
    if (fill >= beats - 1e-9) {
      out.push(cur);
      cur = [];
      fill = 0;
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Partitur: parts = [{ name, clef: "G"|"F", notes: ["C4:1", …] }]. */
export function musicXml({ title, composer, fifths = 0, beats = 4, tempo = 100, parts }) {
  const list = parts.map((p, i) => `<score-part id="P${i + 1}"><part-name>${p.name}</part-name></score-part>`).join("");
  const body = parts
    .map((p, i) => {
      const ms = measures(p.notes, beats);
      return `<part id="P${i + 1}">${ms
        .map((m, k) => {
          const attrs = k === 0
            ? `<attributes><divisions>2</divisions><key><fifths>${fifths}</fifths></key><time><beats>${beats}</beats><beat-type>4</beat-type></time>`
              + `<clef><sign>${p.clef ?? "G"}</sign><line>${p.clef === "F" ? 4 : 2}</line></clef></attributes>`
              + (i === 0 ? `<direction placement="above"><direction-type><words>Tempo</words></direction-type><sound tempo="${tempo}"/></direction>` : "")
            : "";
          return `<measure number="${k + 1}">${attrs}${m.map(noteXml).join("")}</measure>`;
        })
        .join("")}</part>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1"><work><work-title>${title}</work-title></work><identification><creator type="composer">${composer}</creator></identification><part-list>${list}</part-list>${body}</score-partwise>`;
}

/** Melodie, nach der die Tests suchen (Sopran des Testchorals). */
export const CHORAL_MELODY = "C4 D4 E4 F4 G4 G4 A4 A4 A4 A4 G4";

export const PIECES = [
  {
    file: "testchoral.musicxml",
    title: "Testchoral",
    composer: "Test Komponist",
    parts: [
      { name: "Sopran", notes: ["C4:1", "D4:1", "E4:1", "F4:1", "G4:2", "G4:2", "A4:1", "A4:1", "A4:1", "A4:1", "G4:4", "F4:1", "F4:1", "F4:1", "F4:1", "E4:2", "E4:2", "D4:1", "D4:1", "D4:1", "D4:1", "C4:4"] },
      { name: "Alt", notes: ["G3:1", "B3:1", "C4:1", "C4:1", "D4:2", "E4:2", "F4:1", "F4:1", "E4:1", "F4:1", "E4:4", "C4:1", "D4:1", "C4:1", "D4:1", "C4:2", "C4:2", "B3:1", "B3:1", "B3:1", "B3:1", "G3:4"] },
      { name: "Bass", clef: "F", notes: ["C3:1", "G2:1", "C3:1", "A2:1", "B2:2", "C3:2", "F2:1", "F2:1", "C3:1", "F2:1", "C3:4", "A2:1", "B2:1", "A2:1", "B2:1", "C3:2", "A2:2", "G2:1", "G2:1", "G2:1", "G2:1", "C3:4"] },
    ],
  },
  {
    file: "kleines-duett.musicxml",
    title: "Kleines Duett",
    composer: "Zweiter Komponist",
    fifths: 2,
    tempo: 90,
    parts: [
      { name: "Flöte", notes: ["D5:1", "F#5:1", "A5:2", "G5:1", "F#5:1", "E5:2", "D5:1", "E5:1", "F#5:1", "D5:1", "E5:4"] },
      // genug Noten, damit die Stimme in den Index kommt (sehr kurze Stimmen überspringt er)
      { name: "Cello", clef: "F", notes: ["D3:1", "C#3:1", "B2:1", "A2:1", "B2:1", "A2:1", "G2:1", "F#2:1", "G2:1", "A2:1", "B2:1", "C#3:1", "D3:2", "A2:2"] },
    ],
  },
];

/** Schreibt die Teststücke in `dir` und gibt den Ordner zurück. */
export function writePieces(dir) {
  mkdirSync(dir, { recursive: true });
  for (const p of PIECES) writeFileSync(join(dir, p.file), musicXml(p));
  return dir;
}
