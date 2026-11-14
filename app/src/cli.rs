//! Kommandozeile von `klangwelt.exe` – ein Programm für alles:
//!
//! ```text
//! klangwelt                        Fenster öffnen
//! klangwelt <datei.klangwelt>      Projekt öffnen (läuft Klangwelt schon: dort)
//! klangwelt --mcp                  stdio-Brücke für MCP-Clients (Claude Desktop …)
//! klangwelt index <befehl> …       Musikbibliothek: build, query, analyze, chords
//! klangwelt --help | --version
//! ```
//!
//! Die Release-Version ist ein Fensterprogramm ohne eigene Konsole. Für Ausgaben
//! hängt sie sich an die Konsole, aus der sie gestartet wurde (`AttachConsole`);
//! ist die Ausgabe umgeleitet (Pipe, Datei – so bei MCP-Clients), bleibt sie dort.

use klang_mcp::client::{post, split_url};
use klang_mcp::DEFAULT_PORT;
use serde_json::{json, Value};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

pub const HELP: &str = "\
Klangwelt – Musik machen, aufnehmen, erkennen, Klänge gestalten

Aufruf:
  klangwelt                          Fenster öffnen
  klangwelt <datei.klangwelt>        Projekt öffnen (läuft Klangwelt schon, dort)
  klangwelt --mcp                    stdio-Brücke für MCP-Clients wie Claude Desktop;
                                     startet Klangwelt, falls es noch nicht läuft
  klangwelt index build <ordner> <index.kwix>
                                     MusicXML/MXL-Dateien eines Ordners indizieren
  klangwelt index merge <ziel.kwix> <a.kwix> <b.kwix> …
                                     Indizes zu einem verschmelzen (Doppelte einmal)
  klangwelt index query <index.kwix> \"60:1 62:1 64:2 …\"
                                     Melodie suchen (MIDI:Dauer, mind. 5 Noten)
  klangwelt index analyze <datei.musicxml|.mxl>
                                     Stimmen, Kadenzen, Stimmung als JSON
  klangwelt index chords <index.kwix> <tonart> <akkord> …
                                     häufigste Fortsetzungen, z. B. C-Dur C F G7
  klangwelt --version | --help

Umgebung: KLANGWELT_MCP_PORT (Port der App, Standard 7419), KLANGWELT_MCP_URL und
KLANGWELT_MCP_TOKEN (Brücke), KLANGWELT_BIBLIOTHEK (Ordner für Bibliotheken).";

#[derive(Debug, PartialEq)]
pub enum Mode {
    /// Fenster öffnen, optional mit einer Projektdatei.
    Gui { open: Option<PathBuf> },
    Mcp,
    Index(Vec<String>),
    Help,
    Version,
    Error(String),
}

/// Aufruf auswerten (ohne Programmnamen).
pub fn parse(args: &[String]) -> Mode {
    let Some(first) = args.first() else { return Mode::Gui { open: None } };
    match first.as_str() {
        "--mcp" | "mcp" if args.len() == 1 => Mode::Mcp,
        "index" => Mode::Index(args[1..].to_vec()),
        "--help" | "-h" | "/?" | "help" => Mode::Help,
        "--version" | "-V" | "version" => Mode::Version,
        a if args.len() == 1 && (a.to_lowercase().ends_with(".klangwelt") || Path::new(a).is_file()) => Mode::Gui { open: Some(PathBuf::from(a)) },
        _ => Mode::Error(format!("Unbekannter Aufruf: klangwelt {}", args.join(" "))),
    }
}

/// Führt einen Kommandozeilen-Modus aus (nicht das Fenster) und liefert den Exit-Code.
pub fn run(mode: Mode) -> i32 {
    match mode {
        Mode::Mcp => {
            mcp_bridge();
            0
        }
        Mode::Index(args) => {
            attach_console();
            index::run(&args)
        }
        Mode::Help => {
            attach_console();
            println!("{HELP}");
            0
        }
        Mode::Version => {
            attach_console();
            println!("Klangwelt {}", env!("CARGO_PKG_VERSION"));
            0
        }
        Mode::Error(e) => {
            attach_console();
            eprintln!("{e}\n\n{HELP}");
            2
        }
        Mode::Gui { .. } => 0,
    }
}

// ------------------------------------------------------------------ Konsole

/// Fensterprogramm aus einer Konsole gestartet: Ausgaben dorthin. Bei
/// umgeleiteter Ausgabe (Pipe, Datei) oder in der Debug-Version (eigene
/// Konsole) ist nichts zu tun.
#[cfg(windows)]
fn attach_console() {
    #[link(name = "kernel32")]
    extern "system" {
        fn AttachConsole(process_id: u32) -> i32;
        fn GetStdHandle(std_handle: u32) -> *mut std::ffi::c_void;
    }
    const ATTACH_PARENT_PROCESS: u32 = u32::MAX;
    const STD_OUTPUT_HANDLE: u32 = -11i32 as u32;
    // SAFETY: reine Win32-Aufrufe ohne Zeiger-Argumente.
    unsafe {
        if GetStdHandle(STD_OUTPUT_HANDLE).is_null() {
            AttachConsole(ATTACH_PARENT_PROCESS);
        }
    }
}

#[cfg(not(windows))]
fn attach_console() {}

// ------------------------------------------------------------------ Agent / MCP

fn mcp_url() -> String {
    std::env::var("KLANGWELT_MCP_URL").unwrap_or_else(|_| {
        let port = std::env::var("KLANGWELT_MCP_PORT").ok().and_then(|p| p.parse::<u16>().ok()).unwrap_or(DEFAULT_PORT);
        format!("http://127.0.0.1:{port}/mcp")
    })
}

fn mcp_token() -> Option<String> {
    std::env::var("KLANGWELT_MCP_TOKEN").ok().filter(|t| !t.is_empty())
}

/// `klangwelt --mcp`: stdin/stdout ↔ HTTP der laufenden App; startet sie bei Bedarf.
fn mcp_bridge() {
    let url = mcp_url();
    let token = mcp_token();
    let mut start = || start_app(&url);
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    klang_mcp::bridge::run(&url, token.as_deref(), stdin.lock(), stdout.lock(), Some(&mut start));
}

/// Klangwelt (dieses Programm, ohne Argumente) als eigenständiges Fenster starten
/// und warten, bis sein MCP-Server antwortet.
fn start_app(url: &str) -> Result<(), String> {
    use std::process::{Command, Stdio};
    let (host, _) = split_url(url).map_err(|e| e.to_string())?;
    let port = host.rsplit(':').next().and_then(|p| p.parse::<u16>().ok()).unwrap_or(DEFAULT_PORT);
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let make = || {
        let mut c = Command::new(&exe);
        // Das Fenster soll die Pipes des MCP-Clients nicht erben
        c.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        c.env("KLANGWELT_MCP_PORT", port.to_string());
        c
    };
    #[cfg(windows)]
    let child = {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        // Aus dem Job-Objekt des Clients lösen, damit Klangwelt das Ende der Brücke überlebt
        // (nicht jeder Job erlaubt das – dann ohne).
        make()
            .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB)
            .spawn()
            .or_else(|_| make().creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP).spawn())
    };
    #[cfg(not(windows))]
    let child = make().spawn();
    let child = child.map_err(|e| format!("Klangwelt ließ sich nicht starten: {e}"))?;
    eprintln!("Klangwelt gestartet (PID {})", child.id());
    let addr = host.to_socket_addrs().map_err(|e| e.to_string())?.next().ok_or("Adresse nicht auflösbar")?;
    let deadline = Instant::now() + Duration::from_secs(45);
    while Instant::now() < deadline {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Err("Klangwelt wurde gestartet, antwortet aber nicht".into())
}

/// Läuft Klangwelt schon? Dann die Datei dort öffnen (Doppelklick auf ein
/// Projekt soll kein zweites Fenster öffnen). `true` = erledigt.
pub fn forward_open(path: &Path) -> bool {
    let abs = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let abs = abs.display().to_string();
    // \\?\-Präfix von canonicalize entfernen
    let abs = abs.strip_prefix(r"\\?\").unwrap_or(&abs).to_string();
    let body = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "open_project", "arguments": { "path": abs } } }).to_string();
    let auth = mcp_token().map(|t| format!("Bearer {t}"));
    let headers: Vec<(&str, &str)> = auth.as_deref().map(|a| vec![("Authorization", a)]).unwrap_or_default();
    let Ok(r) = post(&mcp_url(), body.as_bytes(), &headers) else { return false };
    if r.status != 200 {
        return false;
    }
    serde_json::from_slice::<Value>(&r.body)
        .ok()
        .and_then(|v| v.get("result").and_then(|res| res.get("isError")).and_then(Value::as_bool).map(|e| !e))
        .unwrap_or(false)
}

// ------------------------------------------------------------------ Bibliothek

/// `klangwelt index …` (früher das eigene Programm `klang-index`).
mod index {
    use klang_music::analysis::analyze_score;
    use klang_music::chordstats::Rel;
    use klang_music::diskindex::{merge, AnyIndex};
    use klang_music::harmony::{chord_name, describe, parse_chord, parse_key};
    use klang_music::library::build_index_to;
    use klang_music::melody::MelodyNote;
    use klang_music::score::load_score;
    use std::path::Path;
    use std::sync::atomic::AtomicBool;
    use std::time::Instant;

    type Res = Result<(), Box<dyn std::error::Error>>;

    pub fn run(args: &[String]) -> i32 {
        let result = match args.first().map(String::as_str) {
            Some("build") if args.len() == 3 => build(Path::new(&args[1]), Path::new(&args[2])),
            Some("merge") if args.len() >= 4 => merge_files(Path::new(&args[1]), &args[2..]),
            Some("query") if args.len() >= 3 => query(Path::new(&args[1]), &args[2..].join(" ")),
            Some("analyze") if args.len() == 2 => analyze(Path::new(&args[1])),
            Some("chords") if args.len() >= 3 => chords(Path::new(&args[1]), &args[2], &args[3..]),
            _ => {
                eprintln!("{}", super::HELP);
                return 2;
            }
        };
        match result {
            Ok(()) => 0,
            Err(e) => {
                eprintln!("Fehler: {e}");
                1
            }
        }
    }

    fn build(dir: &Path, out: &Path) -> Res {
        let started = Instant::now();
        let stats = build_index_to(
            dir,
            out,
            |done, total| {
                if done == 0 {
                    eprintln!("{total} Dateien gefunden");
                } else if done == total {
                    eprintln!("  {done} / {total} – führe Index zusammen …");
                } else if done % 10_000 == 0 {
                    eprintln!("  {done} / {total} …");
                }
            },
            &AtomicBool::new(false),
        )?;
        for e in &stats.errors {
            eprintln!("  übersprungen: {e}");
        }
        println!(
            "Fertig in {:.1} s: {} Partituren, {} Stimmen, {} n-Gramme, {} Fundstellen, {} Fehler → {} ({:.1} MB)",
            started.elapsed().as_secs_f32(),
            stats.scores,
            stats.voices,
            stats.grams,
            stats.postings,
            stats.failed,
            out.display(),
            std::fs::metadata(out).map(|m| m.len() as f64 / 1e6).unwrap_or(0.0)
        );
        Ok(())
    }

    fn merge_files(out: &Path, inputs: &[String]) -> Res {
        let started = Instant::now();
        let loaded: Vec<AnyIndex> = inputs.iter().map(|p| AnyIndex::load(Path::new(p)).map_err(|e| format!("{p}: {e}"))).collect::<Result<_, _>>()?;
        let refs: Vec<&AnyIndex> = loaded.iter().collect();
        let step = std::cell::Cell::new(0u32);
        let stats = merge(&refs, out, true, &|p| {
            if (p * 10.0) as u32 > step.get() {
                step.set((p * 10.0) as u32);
                eprintln!("  {:.0} %", p * 100.0);
            }
        }, &AtomicBool::new(false))?;
        println!(
            "Fertig in {:.1} s: {} Partituren, {} Stimmen ({} Partituren waren doppelt) → {} ({:.1} MB)",
            started.elapsed().as_secs_f32(),
            stats.scores,
            stats.docs,
            stats.skipped_scores,
            out.display(),
            std::fs::metadata(out).map(|m| m.len() as f64 / 1e6).unwrap_or(0.0)
        );
        Ok(())
    }

    pub(super) fn parse_query(s: &str) -> Result<Vec<MelodyNote>, String> {
        let mut t = 0.0;
        s.split(|c: char| c.is_whitespace() || c == ',')
            .filter(|p| !p.is_empty())
            .map(|tok| {
                let (m, d) = tok.split_once(':').unwrap_or((tok, "1"));
                let midi: u8 = m.parse().map_err(|_| format!("ungültige Tonhöhe: {m}"))?;
                let dur: f64 = d.parse().map_err(|_| format!("ungültige Dauer: {d}"))?;
                let n = MelodyNote { onset: t, duration: dur, midi };
                t += dur;
                Ok(n)
            })
            .collect()
    }

    fn query(index_path: &Path, notes: &str) -> Res {
        let q = parse_query(notes)?;
        let started = Instant::now();
        let index = AnyIndex::load(index_path)?;
        let loaded = started.elapsed();
        let hits = index.search(&q, 10);
        eprintln!(
            "Index: {} Stimmen (geladen in {:.2} s), Suche: {:.1} ms",
            index.doc_count(),
            loaded.as_secs_f32(),
            (started.elapsed() - loaded).as_secs_f64() * 1000.0
        );
        if hits.is_empty() {
            println!("Keine Treffer (mindestens 5 Noten angeben).");
        }
        for (i, h) in hits.iter().enumerate() {
            println!(
                "{:2}. {:5.1} %  {} – {} [{} · {}] ab Note {}\n     {}",
                i + 1,
                h.score * 100.0,
                if h.info.composer.is_empty() { "?" } else { &h.info.composer },
                if h.info.title.is_empty() { "(ohne Titel)" } else { &h.info.title },
                h.info.part,
                h.info.voice,
                h.note_index + 1,
                h.info.source
            );
        }
        Ok(())
    }

    /// Häufigste Fortsetzungen nach dem letzten Akkord, mit Beispielen.
    fn chords(index_path: &Path, key: &str, chords: &[String]) -> Res {
        let index = AnyIndex::load(index_path)?;
        let stats = index.chords().ok_or("Index ohne Akkordstatistik (vor KWIX04) – neu indizieren")?;
        let key = parse_key(key).ok_or("Tonart nicht verstanden")?;
        let seq: Vec<_> = chords.iter().map(|c| parse_chord(c, &key).ok_or(format!("Akkord {c}?"))).collect::<Result<_, _>>()?;
        println!("{}: {} Dur-, {} Mollstücke mit Akkordfolge, {} Übergänge", key.name_de(), stats.scores[0], stats.scores[1], stats.transitions());
        let Some(last) = seq.last() else { return Ok(()) };
        let prev = Rel::of(last, &key);
        println!("Nach {} ({}):", chord_name(last, &key), describe(last, &key).roman);
        for (rel, f) in stats.top_after(key.minor, prev, 12) {
            let ch = rel.chord(&key);
            let ex: Vec<String> = f
                .examples
                .iter()
                .take(2)
                .filter_map(|e| {
                    index.doc(e.doc).map(|d| {
                        let comp = d.composer.split_whitespace().collect::<Vec<_>>().join(" ");
                        format!("{} – {} T. {}", if comp.is_empty() { "?" } else { &comp }, d.title.trim(), e.bar)
                    })
                })
                .collect();
            println!("  {:5.1} % {:>6}× {:8} {:8} {}{}", f.share * 100.0, f.count, chord_name(&ch, &key), describe(&ch, &key).roman, if f.exact { "" } else { "(Grundakk.) " }, ex.join(" | "));
        }
        Ok(())
    }

    fn analyze(path: &Path) -> Res {
        let score = load_score(path)?;
        let a = analyze_score(&score);
        println!("{}", serde_json::to_string_pretty(&a)?);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(a: &[&str]) -> Mode {
        parse(&a.iter().map(|s| s.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn parses_modes() {
        assert_eq!(p(&[]), Mode::Gui { open: None });
        assert_eq!(p(&["--mcp"]), Mode::Mcp);
        assert_eq!(p(&["mcp"]), Mode::Mcp);
        assert_eq!(p(&["index", "build", "a", "b"]), Mode::Index(vec!["build".into(), "a".into(), "b".into()]));
        assert_eq!(p(&["index"]), Mode::Index(vec![]));
        assert_eq!(p(&["--help"]), Mode::Help);
        assert_eq!(p(&["-h"]), Mode::Help);
        assert_eq!(p(&["--version"]), Mode::Version);
        assert_eq!(p(&["Mein Lied.klangwelt"]), Mode::Gui { open: Some(PathBuf::from("Mein Lied.klangwelt")) });
        assert!(matches!(p(&["indx"]), Mode::Error(_)), "Tippfehler wird keine Datei");
        assert!(matches!(p(&["--mcp", "x"]), Mode::Error(_)));
        assert!(matches!(p(&["--unbekannt"]), Mode::Error(_)));
    }

    #[test]
    fn parses_melody_queries() {
        let q = index::parse_query("60:1 62, 64:2").unwrap();
        assert_eq!(q.iter().map(|n| (n.midi, n.onset)).collect::<Vec<_>>(), vec![(60, 0.0), (62, 1.0), (64, 2.0)]);
        assert!(index::parse_query("x").is_err());
    }
}
