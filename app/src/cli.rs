//! Command line of `klangwelt.exe` – one program for everything:
//!
//! ```text
//! klangwelt                        Open the window
//! klangwelt <file.klangwelt>       Open a project (if Klangwelt is already running: there)
//! klangwelt --mcp                  stdio bridge for MCP clients (Claude Desktop …)
//! klangwelt index <command> …      Music library: build, query, analyze, chords
//! klangwelt --help | --version
//! ```
//!
//! The release build is a windowed program without a console of its own. To print
//! output it attaches to the console it was started from (`AttachConsole`);
//! if the output is redirected (pipe, file – as with MCP clients), it stays there.

use klang_mcp::client::{post, split_url};
use klang_mcp::DEFAULT_PORT;
use serde_json::{json, Value};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

pub const HELP: &str = "\
Klangwelt – make music, record, recognise, shape sounds

Usage:
  klangwelt                          Open the window
  klangwelt <file.klangwelt>         Open a project (if Klangwelt is already running: there)
  klangwelt --mcp                    stdio bridge for MCP clients such as Claude Desktop;
                                     starts Klangwelt if it isn't running yet
  klangwelt index build <folder> <index.kwix>
                                     Index the MusicXML/MXL files of a folder
  klangwelt index merge <target.kwix> <a.kwix> <b.kwix> …
                                     Merge indexes into one (duplicates once)
  klangwelt index query <index.kwix> \"60:1 62:1 64:2 …\"
                                     Search for a melody (MIDI:duration, at least 5 notes)
  klangwelt index analyze <file.musicxml|.mxl>
                                     Voices, cadences, mood as JSON
  klangwelt index chords <index.kwix> <key> <chord> …
                                     Most frequent continuations, e.g. C-Dur C F G7
                                     (key and chords with German note names)
  klangwelt --version | --help

Environment: KLANGWELT_MCP_PORT (the app's port, default 7419), KLANGWELT_MCP_URL and
KLANGWELT_MCP_TOKEN (bridge), KLANGWELT_BIBLIOTHEK (folder for libraries).";

#[derive(Debug, PartialEq)]
pub enum Mode {
    /// Open the window, optionally with a project file.
    Gui { open: Option<PathBuf> },
    Mcp,
    Index(Vec<String>),
    Help,
    Version,
    Error(String),
}

/// Parse the invocation (without the program name).
pub fn parse(args: &[String]) -> Mode {
    let Some(first) = args.first() else { return Mode::Gui { open: None } };
    match first.as_str() {
        "--mcp" | "mcp" if args.len() == 1 => Mode::Mcp,
        "index" => Mode::Index(args[1..].to_vec()),
        "--help" | "-h" | "/?" | "help" => Mode::Help,
        "--version" | "-V" | "version" => Mode::Version,
        a if args.len() == 1 && (a.to_lowercase().ends_with(".klangwelt") || Path::new(a).is_file()) => Mode::Gui { open: Some(PathBuf::from(a)) },
        _ => Mode::Error(format!("Unknown command: klangwelt {}", args.join(" "))),
    }
}

/// Runs a command-line mode (not the window) and returns the exit code.
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

// ------------------------------------------------------------------ Console

/// Windowed program started from a console: output goes there. If the output is
/// redirected (pipe, file) or in the debug build (own console), there is
/// nothing to do.
#[cfg(windows)]
fn attach_console() {
    #[link(name = "kernel32")]
    extern "system" {
        fn AttachConsole(process_id: u32) -> i32;
        fn GetStdHandle(std_handle: u32) -> *mut std::ffi::c_void;
    }
    const ATTACH_PARENT_PROCESS: u32 = u32::MAX;
    const STD_OUTPUT_HANDLE: u32 = -11i32 as u32;
    // SAFETY: plain Win32 calls without pointer arguments.
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

/// `klangwelt --mcp`: stdin/stdout ↔ HTTP of the running app; starts it if needed.
fn mcp_bridge() {
    let url = mcp_url();
    let token = mcp_token();
    let mut start = || start_app(&url);
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    klang_mcp::bridge::run(&url, token.as_deref(), stdin.lock(), stdout.lock(), Some(&mut start));
}

/// Starts Klangwelt (this program, without arguments) as a standalone window
/// and waits until its MCP server responds.
fn start_app(url: &str) -> Result<(), String> {
    use std::process::{Command, Stdio};
    let (host, _) = split_url(url).map_err(|e| e.to_string())?;
    let port = host.rsplit(':').next().and_then(|p| p.parse::<u16>().ok()).unwrap_or(DEFAULT_PORT);
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let make = || {
        let mut c = Command::new(&exe);
        // The window must not inherit the MCP client's pipes
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
        // Detach from the client's job object so Klangwelt outlives the end of the bridge
        // (not every job allows this – then without).
        make()
            .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB)
            .spawn()
            .or_else(|_| make().creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP).spawn())
    };
    #[cfg(not(windows))]
    let child = make().spawn();
    let child = child.map_err(|e| format!("Klangwelt could not be started: {e}"))?;
    eprintln!("Klangwelt started (PID {})", child.id());
    let addr = host.to_socket_addrs().map_err(|e| e.to_string())?.next().ok_or("Address cannot be resolved")?;
    let deadline = Instant::now() + Duration::from_secs(45);
    while Instant::now() < deadline {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Err("Klangwelt was started but does not respond".into())
}

/// Is Klangwelt already running? Then open the file there (double-clicking a
/// project should not open a second window). `true` = done.
pub fn forward_open(path: &Path) -> bool {
    let abs = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let abs = abs.display().to_string();
    // Strip the \\?\ prefix added by canonicalize
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

// ------------------------------------------------------------------ Library

/// `klangwelt index …` (formerly the separate program `klang-index`).
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
                eprintln!("Error: {e}");
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
                    eprintln!("{total} files found");
                } else if done == total {
                    eprintln!("  {done} / {total} – merging the index …");
                } else if done % 10_000 == 0 {
                    eprintln!("  {done} / {total} …");
                }
            },
            &AtomicBool::new(false),
        )?;
        for e in &stats.errors {
            eprintln!("  skipped: {e}");
        }
        println!(
            "Done in {:.1} s: {} scores, {} voices, {} n-grams, {} postings, {} errors → {} ({:.1} MB)",
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
            "Done in {:.1} s: {} scores, {} voices ({} scores were duplicates) → {} ({:.1} MB)",
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
                let midi: u8 = m.parse().map_err(|_| format!("invalid pitch: {m}"))?;
                let dur: f64 = d.parse().map_err(|_| format!("invalid duration: {d}"))?;
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
            "Index: {} voices (loaded in {:.2} s), search: {:.1} ms",
            index.doc_count(),
            loaded.as_secs_f32(),
            (started.elapsed() - loaded).as_secs_f64() * 1000.0
        );
        if hits.is_empty() {
            println!("No matches (give at least 5 notes).");
        }
        for (i, h) in hits.iter().enumerate() {
            println!(
                "{:2}. {:5.1} %  {} – {} [{} · {}] from note {}\n     {}",
                i + 1,
                h.score * 100.0,
                if h.info.composer.is_empty() { "?" } else { &h.info.composer },
                if h.info.title.is_empty() { "(untitled)" } else { &h.info.title },
                h.info.part,
                h.info.voice,
                h.note_index + 1,
                h.info.source
            );
        }
        Ok(())
    }

    /// Most frequent continuations after the last chord, with examples.
    fn chords(index_path: &Path, key: &str, chords: &[String]) -> Res {
        let index = AnyIndex::load(index_path)?;
        let stats = index.chords().ok_or("Index without chord statistics (before KWIX04) – re-index")?;
        let key = parse_key(key).ok_or("Key not understood")?;
        let seq: Vec<_> = chords.iter().map(|c| parse_chord(c, &key).ok_or(format!("Chord {c}?"))).collect::<Result<_, _>>()?;
        println!("{}: {} major and {} minor pieces with a chord progression, {} transitions", key.name_de(), stats.scores[0], stats.scores[1], stats.transitions());
        let Some(last) = seq.last() else { return Ok(()) };
        let prev = Rel::of(last, &key);
        println!("After {} ({}):", chord_name(last, &key), describe(last, &key).roman);
        for (rel, f) in stats.top_after(key.minor, prev, 12) {
            let ch = rel.chord(&key);
            let ex: Vec<String> = f
                .examples
                .iter()
                .take(2)
                .filter_map(|e| {
                    index.doc(e.doc).map(|d| {
                        let comp = d.composer.split_whitespace().collect::<Vec<_>>().join(" ");
                        format!("{} – {} bar {}", if comp.is_empty() { "?" } else { &comp }, d.title.trim(), e.bar)
                    })
                })
                .collect();
            println!("  {:5.1} % {:>6}× {:8} {:8} {}{}", f.share * 100.0, f.count, chord_name(&ch, &key), describe(&ch, &key).roman, if f.exact { "" } else { "(basic chords) " }, ex.join(" | "));
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
