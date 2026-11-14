//! Musikbibliothek, der Teil nur für den Desktop: Pakete herunterladen (curl)
//! und Partituren in die aktive Bibliothek aufnehmen – im Hintergrund, mit
//! Aufträgen, die einen Neustart überstehen (siehe [`crate::libraries`]).
//!
//! Suchen, Öffnen, Vorspielen und Übernehmen gehören zum gemeinsamen Kern
//! (`klang_app::library`); sie sind hier unter denselben Namen erreichbar.

pub use klang_app::library::*;

use crate::libraries::{self, fmt_de};
use crate::state::{lock, AppState, CmdResult};
use klang_music::fetch::{self, ExtractStats};
use klang_music::library::{build_files_to, collect_files, gather};
use klang_music::pdmx;
use klang_music::score::is_score_file;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State};

/// Baut die aktive Bibliothek aus ihren Quellen neu auf (Pakete, Ordner,
/// Dateien) – z. B. für die Akkordstatistik älterer Indizes.
#[tauri::command]
pub async fn library_reindex(app: AppHandle, state: State<'_, AppState>) -> CmdResult<LibraryInfo> {
    start_rebuild(&app, String::new())?;
    info(&state)
}

/// Stand an die Oberfläche melden („library-changed“).
pub(crate) fn emit_info(app: &AppHandle) {
    klang_app::library::emit_info(&app.state::<AppState>());
}

/// Läuft schon ein Auftrag (Download, Indizieren, Übernehmen, Laden)?
fn check_idle(s: &LibStatus) -> CmdResult<()> {
    if s.building.is_some() || s.download.is_some() || s.adding || s.merging.is_some() || s.pipeline.is_some() {
        return Err("Die Bibliothek wird gerade geladen, indiziert oder übernommen.".into());
    }
    if s.loading {
        return Err("Die Bibliothek wird noch geladen – einen Moment.".into());
    }
    Ok(())
}

/// Aktive Bibliothek (Kennung, Name).
fn active(st: &AppState) -> CmdResult<(String, String)> {
    lock(&st.library)?.as_ref().map(|l| (l.id.clone(), l.name.clone())).ok_or_else(|| "Keine Bibliothek geladen.".to_string())
}

/// Nimmt Partituren (Dateien oder ganze Ordner) in die aktive Bibliothek auf:
/// Sie werden für sich indiziert und mit ihr verschmolzen – schon enthaltene
/// werden übersprungen. Läuft im Hintergrund.
#[tauri::command]
pub async fn library_add(app: AppHandle, state: State<'_, AppState>, paths: Vec<String>) -> CmdResult<LibraryInfo> {
    start_add(&app, &paths)?;
    info(&state)
}

/// Startet das Hinzufügen im Hintergrund (auch für das MCP-Werkzeug); liefert den Namen der Bibliothek.
pub fn start_add(app: &AppHandle, paths: &[String]) -> CmdResult<String> {
    let st = app.state::<AppState>();
    let paths: Vec<PathBuf> = paths.iter().map(|p| p.trim().trim_matches('"')).filter(|p| !p.is_empty()).map(PathBuf::from).collect();
    if paths.is_empty() {
        return Err("Keine Datei angegeben".into());
    }
    let (id, name) = active(&st)?;
    {
        let mut s = lock(&st.library_status)?;
        check_idle(&s)?;
        s.adding = true;
        s.message = Some(format!("Füge {} zu „{name}“ hinzu …", what_paths(&paths)));
    }
    st.library_cancel.store(false, Ordering::SeqCst);
    emit_info(app);
    let handle = app.clone();
    std::thread::Builder::new()
        .name("klang-library-add".into())
        .spawn(move || {
            // Pfade so vermerken, wie sie auf der Platte heißen (für „Neu indizieren“)
            let record: Vec<String> = paths.iter().map(|p| std::fs::canonicalize(p).map(strip_verbatim).unwrap_or_else(|_| p.clone()).display().to_string()).collect();
            index_into(&handle, &id, &paths, &[], &record, "");
            if let Ok(mut s) = handle.state::<AppState>().library_status.lock() {
                s.adding = false;
            }
            emit_info(&handle);
        })
        .map_err(|e| e.to_string())?;
    Ok(name)
}

/// Windows: `\\?\C:\…` aus `canonicalize` wieder zu `C:\…`.
fn strip_verbatim(p: PathBuf) -> PathBuf {
    let s = p.display().to_string();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => p,
    }
}

/// „„Eigene““ bzw. „3 Dateien/Ordner“ für Meldungen.
fn what_paths(paths: &[PathBuf]) -> String {
    match paths {
        [one] => format!("„{}“", one.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| one.display().to_string())),
        more => format!("{} Dateien/Ordner", more.len()),
    }
}

/// Indiziert `paths` (im aufrufenden Thread) in eine Zwischendatei und
/// verschmilzt sie mit der Bibliothek `target`; `packs`/`record` werden dort
/// vermerkt. `prefix` steht vor der Abschlussmeldung. Liefert true, wenn alles
/// übernommen ist.
fn index_into(handle: &AppHandle, target: &str, paths: &[PathBuf], packs: &[String], record: &[String], prefix: &str) -> bool {
    let st = handle.state::<AppState>();
    let root = default_root(handle);
    let lib_name = libraries::read(&root).and_then(|r| r.get(target).map(|l| l.name.clone())).unwrap_or_else(|| target.to_string());
    if let Ok(mut s) = st.library_status.lock() {
        s.building = Some((0, 0));
        s.message = Some(format!("{prefix}Indiziere {} …", what_paths(paths)));
    }
    emit_info(handle);
    let (files, meta, missing) = gather(paths);
    let tmp = libraries::index_dir(&root).join(format!(".zugang-{target}.kwix"));
    let _ = std::fs::create_dir_all(libraries::index_dir(&root));
    let last = std::cell::Cell::new(Instant::now());
    let built = build_files_to(
        &files,
        &meta,
        &tmp,
        |done, total| {
            if let Ok(mut s) = st.library_status.lock() {
                s.building = Some((done, total));
            }
            if last.get().elapsed() > Duration::from_millis(250) || done == total {
                last.set(Instant::now());
                emit_info(handle);
            }
        },
        &st.library_cancel,
    );
    if let Ok(mut s) = st.library_status.lock() {
        s.building = None;
    }
    let result = built
        .map_err(|e| if e.kind() == std::io::ErrorKind::Interrupted { "abgebrochen".to_string() } else { e.to_string() })
        .and_then(|b| libraries::merge_into(handle, target, &tmp, packs, record).map(|m| (b, m)));
    let _ = std::fs::remove_file(&tmp);
    let ok = result.is_ok();
    let message = match result {
        Ok((b, m)) => {
            let new_scores = b.scores.saturating_sub(m.skipped_scores as usize);
            let mut parts = vec![match (new_scores, b.scores) {
                (0, 0) => "Keine Partituren gefunden".to_string(),
                (0, _) => "Nichts Neues".to_string(),
                (1, _) => "1 Partitur übernommen".to_string(),
                (n, _) => format!("{} Partituren übernommen", fmt_de(n)),
            }];
            if m.skipped_scores > 0 {
                parts.push(format!("{} schon enthalten", fmt_de(m.skipped_scores as usize)));
            }
            if b.failed > 0 {
                parts.push(format!("{} nicht lesbar ({})", b.failed, b.errors.first().cloned().unwrap_or_default()));
            }
            if !missing.is_empty() {
                parts.push(missing.join("; "));
            }
            format!("{prefix}{} – „{lib_name}“ hat jetzt {} Partituren.", parts.join(", "), fmt_de(m.scores as usize))
        }
        Err(e) if e == "abgebrochen" => "Abgebrochen – die Bibliothek ist unverändert.".to_string(),
        Err(e) => format!("{prefix}Übernehmen fehlgeschlagen: {e}"),
    };
    if let Ok(mut s) = st.library_status.lock() {
        s.message = Some(message);
    }
    emit_info(handle);
    ok
}

/// Baut die aktive Bibliothek aus ihren Quellen neu (im Hintergrund).
fn start_rebuild(app: &AppHandle, prefix: String) -> CmdResult<()> {
    let st = app.state::<AppState>();
    let (id, name) = active(&st)?;
    let root = default_root(app);
    let entry = libraries::read(&root).and_then(|r| r.get(&id).cloned()).ok_or("Die Bibliothek fehlt in der Liste.")?;
    let mut sources: Vec<PathBuf> = entry.packs.iter().filter_map(|p| libraries::pack_dir(app, p)).filter(|d| d.is_dir()).collect();
    sources.extend(entry.paths.iter().map(PathBuf::from).filter(|p| p.exists()));
    if sources.is_empty() {
        return Err(format!("„{name}“ hat keine Quellen zum Neuaufbau (Pakete oder Ordner fehlen)."));
    }
    {
        let mut s = lock(&st.library_status)?;
        check_idle(&s)?;
        s.building = Some((0, 0));
        s.message = Some(format!("{prefix}Baue „{name}“ neu auf …"));
    }
    st.library_cancel.store(false, Ordering::SeqCst);
    emit_info(app);
    let handle = app.clone();
    std::thread::Builder::new()
        .name("klang-library-rebuild".into())
        .spawn(move || {
            let st = handle.state::<AppState>();
            let (files, meta, _) = gather(&sources);
            let target = libraries::index_dir(&root).join(libraries::other_file(&entry.file));
            let last = std::cell::Cell::new(Instant::now());
            let built = build_files_to(
                &files,
                &meta,
                &target,
                |done, total| {
                    if let Ok(mut s) = st.library_status.lock() {
                        s.building = Some((done, total));
                    }
                    if last.get().elapsed() > Duration::from_millis(250) || done == total {
                        last.set(Instant::now());
                        emit_info(&handle);
                    }
                },
                &st.library_cancel,
            );
            let message = match built {
                Ok(b) => match libraries::install(&handle, &id, &target, |e| {
                    e.scores = b.scores;
                    e.voices = b.voices;
                }) {
                    Ok(()) => format!("{prefix}„{name}“ neu aufgebaut: {} Partituren, {} Stimmen.", fmt_de(b.scores), fmt_de(b.voices)),
                    Err(e) => format!("Neuaufbau fehlgeschlagen: {e}"),
                },
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => "Neuaufbau abgebrochen – die Bibliothek ist unverändert.".to_string(),
                Err(e) => format!("Neuaufbau fehlgeschlagen: {e}"),
            };
            if let Ok(mut s) = st.library_status.lock() {
                s.building = None;
                s.message = Some(message);
            }
            emit_info(&handle);
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------- Aufträge
//
// Herunterladen → Genre/Komponist → Indizieren → in die Bibliothek übernehmen
// läuft im Hintergrund. Damit ein Neustart (oder Absturz) nichts verliert,
// steht der Stand als `klangwelt-auftrag.json` im Paketordner und die Ordner
// offener Aufträge in einer Liste der App. Beim Start geht es automatisch
// weiter; die Datei verschwindet, wenn die Partituren übernommen sind.

const JOB_FILE: &str = "klangwelt-auftrag.json";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
enum JobPhase {
    /// Partituren werden geladen (unterbrochen: Download neu starten).
    Laden,
    /// Genre/Komponist (PDMX.csv) fehlen noch.
    Metadaten,
    /// Partituren und Metadaten da, Index fehlt.
    Indizieren,
    /// Von Hand abgebrochen – nicht von selbst fortsetzen.
    Abgebrochen,
}

#[derive(Clone, Debug, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Job {
    name: String,
    with_meta: bool,
    phase: JobPhase,
    /// Fehlgeschlagene automatische Versuche (nach 3 wird nicht mehr fortgesetzt).
    #[serde(default)]
    attempts: u32,
    /// Ziel: Kennung der Bibliothek (fehlt bei alten Aufträgen: die aktive)
    #[serde(default)]
    library: Option<String>,
    /// Paket aus dem Katalog (fehlt bei alten Aufträgen)
    #[serde(default)]
    pack: Option<String>,
}

fn read_job(dir: &Path) -> Option<Job> {
    serde_json::from_slice(&std::fs::read(dir.join(JOB_FILE)).ok()?).ok()
}

fn jobs_list(handle: &AppHandle) -> Option<PathBuf> {
    if std::env::var_os("KLANGWELT_BIBLIOTHEK").is_some_and(|r| !r.is_empty()) {
        return Some(default_root(handle).join("bibliothek-auftraege.txt"));
    }
    handle.path().app_data_dir().ok().map(|d| d.join("bibliothek-auftraege.txt"))
}

fn listed_folders(handle: &AppHandle) -> Vec<PathBuf> {
    jobs_list(handle)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| s.lines().filter(|l| !l.trim().is_empty()).map(PathBuf::from).collect())
        .unwrap_or_default()
}

fn set_listed(handle: &AppHandle, dir: &Path, present: bool) {
    let Some(list) = jobs_list(handle) else { return };
    let mut v = listed_folders(handle);
    v.retain(|p| p != dir);
    if present {
        v.push(dir.to_path_buf());
    }
    if let Some(parent) = list.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(list, v.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join("\n"));
}

fn write_job(handle: &AppHandle, dir: &Path, job: &Job) {
    if let Ok(json) = serde_json::to_vec_pretty(job) {
        let _ = std::fs::write(dir.join(JOB_FILE), json);
    }
    set_listed(handle, dir, true);
}

fn set_phase(handle: &AppHandle, dir: &Path, phase: JobPhase) {
    if let Some(mut j) = read_job(dir) {
        j.phase = phase;
        write_job(handle, dir, &j);
    }
}

fn finish_job(handle: &AppHandle, dir: &Path) {
    let _ = std::fs::remove_file(dir.join(JOB_FILE));
    set_listed(handle, dir, false);
}

/// Liegt irgendwo unter `dir` eine Partitur? (bricht beim ersten Fund ab)
fn any_score(dir: &Path) -> bool {
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if is_score_file(&p) && !p.extension().is_some_and(|x| x.eq_ignore_ascii_case("xml")) {
                return true;
            }
        }
    }
    false
}

/// Nach dem Laden: Genre/Komponist (falls gewünscht und noch nicht da), dann
/// indizieren und in die Bibliothek des Auftrags übernehmen. Hält den Auftrag
/// aktuell; nach Erfolg ist er erledigt.
fn finish_pipeline(handle: &AppHandle, dir: &Path, job: &Job, mut what: String, fetch_meta: bool) {
    let st = handle.state::<AppState>();
    let name = job.name.as_str();
    if job.with_meta && fetch_meta {
        set_phase(handle, dir, JobPhase::Metadaten);
        if let Ok(mut s) = st.library_status.lock() {
            if s.download.is_none() {
                s.download = Some(DownloadProgress {
                    name: name.to_string(),
                    phase: "Kategorien".into(),
                    folder: dir.display().to_string(),
                    files: 0,
                    target: None,
                    bytes: 0,
                    total_bytes: PDMX_CSV_BYTES,
                });
            }
        }
        // Genre/Komponist: Fehler sind kein Grund, nicht zu indizieren.
        match fetch_metadata(handle, dir, name) {
            Ok(n) => what.push_str(&format!("Genre/Komponist für {n}. ")),
            Err(e) => what.push_str(&format!("({e}) ")),
        }
    }
    if let Ok(mut s) = st.library_status.lock() {
        s.download = None;
    }
    if st.library_cancel.load(Ordering::SeqCst) {
        set_phase(handle, dir, JobPhase::Abgebrochen);
        if let Ok(mut s) = st.library_status.lock() {
            s.message = Some(format!("{name}: abgebrochen."));
        }
        emit_info(handle);
        return;
    }
    set_phase(handle, dir, JobPhase::Indizieren);
    // Ziel: die Bibliothek des Auftrags (alte Aufträge: die aktive, sonst „Standard“)
    let target = job
        .library
        .clone()
        .or_else(|| active(&st).ok().map(|a| a.0))
        .unwrap_or_else(|| libraries::STANDARD.to_string());
    let packs: Vec<String> = job.pack.iter().cloned().collect();
    // Liegt das Paket nicht in seinem Standardordner, den Ordner vermerken (für „Neu indizieren“)
    let default_dir = job.pack.as_deref().and_then(|p| libraries::pack_dir(handle, p));
    let record: Vec<String> = if default_dir.as_deref() == Some(dir) { Vec::new() } else { vec![dir.display().to_string()] };
    if index_into(handle, &target, &[dir.to_path_buf()], &packs, &record, &what) {
        finish_job(handle, dir);
    } else if st.library_cancel.load(Ordering::SeqCst) {
        set_phase(handle, dir, JobPhase::Abgebrochen);
    } else if let Some(mut j) = read_job(dir) {
        j.attempts += 1;
        write_job(handle, dir, &j);
    }
}

/// Beim Start (nach dem Laden der Bibliothek): unterbrochene Aufträge
/// fortsetzen (Genre/Komponist, Indizieren, Übernehmen). Ein unterbrochener
/// Download wird nur gemeldet – „Herunterladen“ setzt ihn fort.
pub fn resume_pending(handle: &AppHandle) {
    let root = default_root(handle);
    let mut folders: Vec<PathBuf> = PACKS.iter().map(|p| root.join(p.folder)).collect();
    for f in listed_folders(handle) {
        if !folders.contains(&f) {
            folders.push(f);
        }
    }
    let mut todo: Vec<(PathBuf, Job)> = Vec::new();
    let mut notes: Vec<String> = Vec::new();
    for dir in folders {
        if !dir.is_dir() {
            set_listed(handle, &dir, false);
            continue;
        }
        match read_job(&dir) {
            Some(j) if j.attempts >= 3 => notes.push(format!("{}: Übernehmen mehrfach fehlgeschlagen – bitte erneut herunterladen.", j.name)),
            Some(j) => match j.phase {
                JobPhase::Metadaten | JobPhase::Indizieren => todo.push((dir, j)),
                JobPhase::Laden => notes.push(format!("{}: Download wurde unterbrochen – „Herunterladen“ setzt ihn fort (vorhandene Partituren werden übersprungen).", j.name)),
                JobPhase::Abgebrochen => {}
            },
            None => {}
        }
    }
    let st = handle.state::<AppState>();
    if todo.is_empty() {
        if !notes.is_empty() {
            if let Ok(mut s) = st.library_status.lock() {
                s.message = Some(notes.join(" "));
            }
            emit_info(handle);
        }
        return;
    }
    let handle = handle.clone();
    let _ = std::thread::Builder::new().name("klang-fortsetzen".into()).spawn(move || {
        // kurz warten, bis die Oberfläche steht
        std::thread::sleep(Duration::from_secs(2));
        let st = handle.state::<AppState>();
        for (dir, job) in todo {
            {
                let Ok(mut s) = st.library_status.lock() else { return };
                if check_idle(&s).is_err() {
                    return; // etwas anderes läuft schon
                }
                s.message = Some(format!("{}: wird fertiggestellt (unterbrochen beim letzten Mal) …", job.name));
                s.pipeline = Some(QueuedDownload {
                    id: job.pack.clone().unwrap_or_default(),
                    name: job.name.clone(),
                    library: job.library.clone().unwrap_or_default(),
                    library_name: String::new(),
                    folder: None,
                    with_meta: job.with_meta,
                });
            }
            let _running = PipelineGuard(handle.clone());
            st.library_cancel.store(false, Ordering::SeqCst);
            write_job(&handle, &dir, &job);
            emit_info(&handle);
            let fetch_meta = job.phase == JobPhase::Metadaten && !dir.join(pdmx::META_FILE).is_file();
            finish_pipeline(&handle, &dir, &job, format!("{} (beim letzten Mal unterbrochen): ", job.name), fetch_meta);
        }
        // Hinweise (z. B. unterbrochener Download) an die Abschlussmeldung hängen
        if !notes.is_empty() {
            if let Ok(mut s) = st.library_status.lock() {
                let m = s.message.take().unwrap_or_default();
                s.message = Some(format!("{m} {}", notes.join(" ")).trim().to_string());
            }
            emit_info(&handle);
        }
    });
}

/// Hält `pipeline` gesetzt, solange ein Download-Auftrag läuft, und gibt sie
/// am Ende frei (auch nach einem Fehler) – dann kommt das nächste Paket der
/// Warteschlange dran.
struct PipelineGuard(AppHandle);

impl Drop for PipelineGuard {
    fn drop(&mut self) {
        if let Ok(mut s) = self.0.state::<AppState>().library_status.lock() {
            s.pipeline = None;
        }
        emit_info(&self.0);
    }
}

// ---------------------------------------------------------------- Herunterladen

/// Eine Musikbibliothek, die die App herunterladen kann.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    id: &'static str,
    name: &'static str,
    description: &'static str,
    /// ungefähre Zahl der Partituren
    scores: usize,
    download_mb: u32,
    disk_mb: u32,
    license: &'static str,
    source_url: &'static str,
    /// Sammlung (Panel in der Oberfläche): „pdmx“, „openscore“, „kernscores“, „dcml“
    group: &'static str,
    group_name: &'static str,
    group_description: &'static str,
    /// Dateiformat der Partituren (für die Anzeige)
    format: &'static str,
    /// Bringt eine Akkordanalyse von Fachleuten mit
    expert_harmony: bool,
    /// vorgeschlagener Zielordner
    folder: String,
    /// Die Partituren liegen schon im Ordner (Übernehmen ohne Download)
    installed: bool,
    /// Name der aktiven Bibliothek, wenn sie das Paket schon enthält
    in_library: Option<String>,
}

/// PDMX (Long et al. 2024): gemeinfreie MusicXML-Partituren von MuseScore,
/// Datensatz unter CC-BY 4.0. Das Archiv ist ein großes .tar.gz; die
/// kleineren Pakete lesen nur seinen Anfang (bunt gemischte Auswahl).
const PDMX_MXL_URL: &str = "https://zenodo.org/api/records/15571083/files/mxl.tar.gz/content";
/// Metadaten aller PDMX-Partituren (Genre, Komponist, Schwierigkeit …).
const PDMX_CSV_URL: &str = "https://zenodo.org/api/records/15571083/files/PDMX.csv/content";
const PDMX_CSV_BYTES: u64 = 225_399_738;
const PDMX_RECORD: &str = "https://zenodo.org/records/15571083";
const PDMX_BYTES: u64 = 1_894_335_797;
const PDMX_LICENSE: &str = "Partituren gemeinfrei bzw. CC0 laut MuseScore · Datensatz PDMX (Long et al. 2024) unter CC-BY 4.0";

/// Ein Ordner aus einem GitHub-Repositorium.
struct Repo {
    repo: &'static str,
    branch: &'static str,
    /// Unterordner im Bibliotheksordner („“ = direkt hinein)
    sub: &'static str,
    /// Welche Dateien geladen werden (Pfad im Repositorium)
    want: fn(&str) -> bool,
}

enum Source {
    /// PDMX-Archiv; None = alles, sonst die ersten N Partituren
    Pdmx(Option<usize>),
    /// Einzelne Dateien aus GitHub-Repositorien
    Repos(&'static [Repo]),
}

struct Group {
    id: &'static str,
    name: &'static str,
    description: &'static str,
}

const GROUPS: [Group; 4] = [
    Group {
        id: "pdmx",
        name: "PDMX – gemeinfreie MuseScore-Partituren",
        description: "Riesige, bunt gemischte Sammlung: Klassik, Volkslieder, Pop-Bearbeitungen, Übungsstücke. Gut für die Melodiesuche – die Qualität schwankt (Abschriften von Laien, viele Bearbeitungen).",
    },
    Group {
        id: "openscore",
        name: "OpenScore – sorgfältig gesetzte Partituren",
        description: "Von Freiwilligen nach Erstausgaben gesetzt und geprüft, gemeinfrei (CC0). Kunstlieder und Streichquartette, darunter Mozart, Beethoven, Haydn, Schubert, Brahms.",
    },
    Group {
        id: "kernscores",
        name: "KernScores – Forschungsausgaben im Humdrum-Format",
        description: "Der akademische Standard des CCARH (Stanford): je ein Paket pro Epoche vom Barock bis ins 20. Jahrhundert, darunter Bachs Choräle und das Wohltemperierte Klavier, Mozarts und Beethovens Klaviersonaten – fehlerarm und vollständig. Nicht kommerziell (meist CC BY-NC-SA 4.0, einige Sammlungen ohne Lizenzangabe).",
    },
    Group {
        id: "dcml",
        name: "DCML – mit Harmonieanalyse von Fachleuten",
        description: "Korpora des Digital and Cognitive Musicology Lab (EPFL Lausanne): zu jedem Takt eine geprüfte Akkordanalyse, von Monteverdi bis Bartók, je ein Paket pro Epoche. Klangwelt zählt diese Analyse statt der automatischen Erkennung – die Akkordstatistik im Harmonie-Fenster wird dadurch verlässlicher. Nicht kommerziell (CC BY-NC-SA 4.0).",
    },
];

struct Pack {
    id: &'static str,
    name: &'static str,
    folder: &'static str,
    description: &'static str,
    group: &'static str,
    format: &'static str,
    license: &'static str,
    source_url: &'static str,
    source: Source,
    scores: usize,
    download_mb: u32,
    disk_mb: u32,
}

impl Pack {
    fn is_pdmx(&self) -> bool {
        matches!(self.source, Source::Pdmx(_))
    }
}

fn mxl_in_scores(p: &str) -> bool {
    p.starts_with("scores/") && p.ends_with(".mxl")
}
fn kern_file(p: &str) -> bool {
    p.starts_with("kern/") && p.ends_with(".krn")
}
/// DCML: Notentabellen, Harmonien und Metadaten (die .mscx-Dateien wären zehnmal so groß).
fn dcml_tables(p: &str) -> bool {
    p == "metadata.tsv" || (p.starts_with("notes/") && p.ends_with(".notes.tsv")) || (p.starts_with("harmonies/") && p.ends_with(".harmonies.tsv"))
}

const OPENSCORE_LICENSE: &str = "CC0 1.0 (gemeinfrei) · OpenScore, https://openscore.cc";
/// Stand November 2026: Die Repositorien von Craig Stuart Sapp tragen meist
/// CC BY-NC-SA 4.0 (LICENSE.txt), einige haben keine Lizenzdatei.
const KERN_LICENSE: &str = "KernScores (Craig Stuart Sapp, CCARH Stanford): meist CC BY-NC-SA 4.0, einige Sammlungen ohne Lizenzangabe – nur privat und nicht kommerziell nutzen, Quelle nennen";
/// Komponist einer Sammlung, die nur ein Komponist geschrieben hat – gilt für
/// Partituren, deren Quelle ihn nicht nennt (DCML-Bach-Choräle, einzelne Sätze
/// bei Couperin, Liszt …). Sammlungen mehrerer Komponisten fehlen hier.
fn repo_composer(repo: &str) -> Option<&'static str> {
    Some(match repo.split('/').nth(1)? {
        "bach-370-chorales" | "bach-wtc" | "art-of-the-fugue" | "bach-musical-offering" | "inventions" | "bach_chorales" | "bach_en_fr_suites" | "bach_solo" => "Johann Sebastian Bach",
        "mozart-piano-sonatas" | "mozart_piano_sonatas" => "Wolfgang Amadeus Mozart",
        "beethoven-piano-sonatas" | "beethoven-string-quartets" | "beethoven_piano_sonatas" | "ABC" => "Ludwig van Beethoven",
        "haydn-piano-sonatas" => "Joseph Haydn",
        "scarlatti-keyboard-sonatas" | "scarlatti_sonatas" => "Domenico Scarlatti",
        "vivaldi-op6" => "Antonio Vivaldi",
        "chopin-mazurkas" | "chopin-preludes" | "chopin_mazurkas" => "Frédéric Chopin",
        "hummel-preludes" => "Johann Nepomuk Hummel",
        "schubert-songs" | "schubert_winterreise" => "Franz Schubert",
        "foster-songs" => "Stephen Foster",
        "joplin" => "Scott Joplin",
        "gershwin-songs" => "George Gershwin",
        "corelli" => "Arcangelo Corelli",
        "couperin_concerts" | "couperin_clavecin" => "François Couperin",
        "kleine_geistliche_konzerte" => "Heinrich Schütz",
        "frescobaldi_fiori_musicali" => "Girolamo Frescobaldi",
        "monteverdi_madrigals" => "Claudio Monteverdi",
        "pergolesi_stabat_mater" => "Giovanni Battista Pergolesi",
        "peri_euridice" => "Jacopo Peri",
        "handel_keyboard" => "Georg Friedrich Händel",
        "wf_bach_sonatas" => "Wilhelm Friedemann Bach",
        "cpe_bach_keyboard" => "Carl Philipp Emanuel Bach",
        "jc_bach_sonatas" => "Johann Christian Bach",
        "kozeluh_sonatas" => "Leopold Koželuch",
        "pleyel_quartets" => "Ignaz Pleyel",
        "schumann_kinderszenen" | "schumann_liederkreis" => "Robert Schumann",
        "c_schumann_lieder" => "Clara Schumann",
        "mendelssohn_quartets" => "Felix Mendelssohn Bartholdy",
        "liszt_pelerinage" => "Franz Liszt",
        "grieg_lyric_pieces" => "Edvard Grieg",
        "tchaikovsky_seasons" => "Pjotr Iljitsch Tschaikowsky",
        "dvorak_silhouettes" => "Antonín Dvořák",
        "wagner_overtures" => "Richard Wagner",
        "mahler_kindertotenlieder" => "Gustav Mahler",
        "medtner_tales" => "Nikolai Medtner",
        "debussy_suite_bergamasque" => "Claude Debussy",
        "ravel_piano" => "Maurice Ravel",
        "rachmaninoff_piano" => "Sergei Rachmaninow",
        "bartok_bagatelles" => "Béla Bartók",
        "poulenc_mouvements_perpetuels" => "Francis Poulenc",
        "schulhoff_suite_dansante_en_jazz" => "Erwin Schulhoff",
        _ => return None,
    })
}

/// Mitgelieferte Dateilisten der Sammlungen – Ausweg, wenn die GitHub-API nicht antwortet.
const SAMMLUNGEN: &str = include_str!("sammlungen.txt");
const DCML_LICENSE: &str = "CC BY-NC-SA 4.0 · DCML, EPFL Lausanne – bei Verwendung zitieren, nicht kommerziell";

/// Größen aus den Dateilisten der Repositorien (November 2026). PDMX
/// gemessen (≈ 3 MB/s): Kostprobe ≈ 10 s, Auswahl ≈ 1,5 min; der ganze
/// Datensatz ist hochgerechnet (Index auf der Platte, Format 3).
const PACKS: [Pack; 13] = [
    Pack {
        id: "pdmx-kostprobe",
        name: "PDMX – Kostprobe",
        folder: "PDMX-Kostprobe",
        description: "3 000 bunt gemischte Partituren zum Ausprobieren – in etwa 10 Sekunden geladen und indiziert.",
        group: "pdmx",
        format: "MusicXML",
        license: PDMX_LICENSE,
        source_url: PDMX_RECORD,
        source: Source::Pdmx(Some(3_000)),
        scores: 3_000,
        download_mb: 21,
        disk_mb: 50,
    },
    Pack {
        id: "pdmx-auswahl",
        name: "PDMX – Auswahl",
        folder: "PDMX-Auswahl",
        description: "30 000 Partituren: Klassik, Volkslieder, Choräle, Pop-Bearbeitungen, Übungsstücke – gut für die Melodiesuche. Etwa 1,5 Minuten.",
        group: "pdmx",
        format: "MusicXML",
        license: PDMX_LICENSE,
        source_url: PDMX_RECORD,
        source: Source::Pdmx(Some(30_000)),
        scores: 30_000,
        download_mb: 220,
        disk_mb: 380,
    },
    Pack {
        id: "pdmx-voll",
        name: "PDMX – vollständig",
        folder: "PDMX",
        description: "Der ganze Datensatz mit rund 254 000 Partituren. Je nach Leitung 5–15 Minuten Download, danach einige Minuten Indizieren; der Index liegt auf der Platte, beim Suchen genügen rund 0,2 GB Arbeitsspeicher. Abbrechen und später fortsetzen ist möglich.",
        group: "pdmx",
        format: "MusicXML",
        license: PDMX_LICENSE,
        source_url: PDMX_RECORD,
        source: Source::Pdmx(None),
        scores: 254_000,
        download_mb: 1_895,
        disk_mb: 3_500,
    },
    Pack {
        id: "openscore-lieder",
        name: "OpenScore – Lieder",
        folder: "OpenScore-Lieder",
        description: "Rund 1 460 Kunstlieder für Singstimme und Klavier: Brahms, Schubert, Schumann (Robert und Clara), Fanny Hensel, Wolf, Fauré, Debussy und viele Komponistinnen des 19. Jahrhunderts.",
        group: "openscore",
        format: "MusicXML",
        license: OPENSCORE_LICENSE,
        source_url: "https://github.com/OpenScore/Lieder",
        source: Source::Repos(&[Repo { repo: "OpenScore/Lieder", branch: "main", sub: "", want: mxl_in_scores }]),
        scores: 1_460,
        download_mb: 19,
        disk_mb: 30,
    },
    Pack {
        id: "openscore-quartette",
        name: "OpenScore – Streichquartette",
        folder: "OpenScore-Streichquartette",
        description: "Rund 200 Sätze für Streichquartett: Haydn (38), Mozart (23), Dvořák (18), Beethoven (12), Schubert, Mendelssohn, Brahms, Ravel und andere.",
        group: "openscore",
        format: "MusicXML",
        license: OPENSCORE_LICENSE,
        source_url: "https://github.com/OpenScore/StringQuartets",
        source: Source::Repos(&[Repo { repo: "OpenScore/StringQuartets", branch: "main", sub: "", want: mxl_in_scores }]),
        scores: 196,
        download_mb: 40,
        disk_mb: 50,
    },
    Pack {
        id: "kern-barock",
        name: "Barock",
        folder: "KernScores-Barock",
        description: "Bach: alle 370 vierstimmigen Choräle, beide Bände des Wohltemperierten Klaviers (jede Fugenstimme einzeln), Die Kunst der Fuge, Das Musikalische Opfer, zwei- und dreistimmige Inventionen · Scarlatti: 65 Klaviersonaten · Vivaldi: Concerti op. 6.",
        group: "kernscores",
        format: "**kern",
        license: KERN_LICENSE,
        source_url: "https://github.com/craigsapp",
        source: Source::Repos(&[
            Repo { repo: "craigsapp/bach-370-chorales", branch: "main", sub: "Bach-Choraele", want: kern_file },
            Repo { repo: "humdrum-tools/bach-wtc", branch: "main", sub: "Bach-Wohltemperiertes-Klavier", want: kern_file },
            Repo { repo: "craigsapp/art-of-the-fugue", branch: "main", sub: "Bach-Kunst-der-Fuge", want: kern_file },
            Repo { repo: "craigsapp/bach-musical-offering", branch: "main", sub: "Bach-Musikalisches-Opfer", want: kern_file },
            Repo { repo: "humdrum-tools/inventions", branch: "main", sub: "Bach-Inventionen", want: kern_file },
            Repo { repo: "craigsapp/scarlatti-keyboard-sonatas", branch: "main", sub: "Scarlatti-Sonaten", want: kern_file },
            Repo { repo: "craigsapp/vivaldi-op6", branch: "main", sub: "Vivaldi-op6", want: kern_file },
        ]),
        scores: 605,
        download_mb: 7,
        disk_mb: 12,
    },
    Pack {
        id: "kern-klassik",
        name: "Klassik",
        folder: "KernScores-Klassik",
        description: "Mozart: alle 18 Klaviersonaten (69 Sätze) · Beethoven: alle 32 Klaviersonaten (103 Sätze) und alle 16 Streichquartette (71 Sätze) · Haydn: Klaviersonaten (25 Sätze).",
        group: "kernscores",
        format: "**kern",
        license: KERN_LICENSE,
        source_url: "https://github.com/craigsapp/beethoven-string-quartets",
        source: Source::Repos(&[
            Repo { repo: "craigsapp/mozart-piano-sonatas", branch: "main", sub: "Mozart-Klaviersonaten", want: kern_file },
            Repo { repo: "craigsapp/beethoven-piano-sonatas", branch: "main", sub: "Beethoven-Klaviersonaten", want: kern_file },
            Repo { repo: "craigsapp/haydn-piano-sonatas", branch: "master", sub: "Haydn-Klaviersonaten", want: kern_file },
            Repo { repo: "craigsapp/beethoven-string-quartets", branch: "main", sub: "Beethoven-Streichquartette", want: kern_file },
        ]),
        scores: 268,
        download_mb: 9,
        disk_mb: 15,
    },
    Pack {
        id: "kern-romantik",
        name: "Romantik",
        folder: "KernScores-Romantik",
        description: "Chopin: Mazurken und Préludes · Hummel: Präludien · Schubert: Lieder · Stephen Foster: Songs · Erks Deutscher Liederschatz (232 Volkslieder).",
        group: "kernscores",
        format: "**kern",
        license: KERN_LICENSE,
        source_url: "https://github.com/craigsapp/chopin-mazurkas",
        source: Source::Repos(&[
            Repo { repo: "craigsapp/chopin-mazurkas", branch: "main", sub: "Chopin-Mazurken", want: kern_file },
            Repo { repo: "craigsapp/chopin-preludes", branch: "main", sub: "Chopin-Preludes", want: kern_file },
            Repo { repo: "craigsapp/hummel-preludes", branch: "main", sub: "Hummel-Praeludien", want: kern_file },
            Repo { repo: "humdrum-tools/schubert-songs", branch: "main", sub: "Schubert-Lieder", want: kern_file },
            Repo { repo: "humdrum-tools/foster-songs", branch: "main", sub: "Foster-Songs", want: kern_file },
            Repo { repo: "craigsapp/erk-liederschatz", branch: "main", sub: "Erk-Liederschatz", want: kern_file },
        ]),
        scores: 405,
        download_mb: 6,
        disk_mb: 10,
    },
    Pack {
        id: "kern-20jh",
        name: "Um 1900 und 20. Jahrhundert",
        folder: "KernScores-20Jh",
        description: "Scott Joplin: Ragtimes (47) · George Gershwin: Songs (29).",
        group: "kernscores",
        format: "**kern",
        license: KERN_LICENSE,
        source_url: "https://github.com/craigsapp/joplin",
        source: Source::Repos(&[
            Repo { repo: "craigsapp/joplin", branch: "main", sub: "Joplin", want: kern_file },
            Repo { repo: "humdrum-tools/gershwin-songs", branch: "main", sub: "Gershwin", want: kern_file },
        ]),
        scores: 76,
        download_mb: 3,
        disk_mb: 5,
    },
    Pack {
        id: "dcml-barock",
        name: "Barock, analysiert",
        folder: "DCML-Barock",
        description: "Bach (Englische und Französische Suiten, Sonaten, Partiten und Suiten für Violine, Violoncello und Flöte solo) · Corelli (Triosonaten, 149 Sätze) · Couperin (Concerts royaux, Clavecin-Stücke) · Scarlatti (69 Sonaten) · Schütz (Kleine geistliche Konzerte) · Frescobaldi (Fiori musicali) · Monteverdi (Madrigale) · Pergolesi (Stabat mater) · Peri (Euridice) · Händel (Klavier) · W. F. Bach · dazu 361 Bach-Choräle (diese ohne Analyse).",
        group: "dcml",
        format: "DCML-Tabellen",
        license: DCML_LICENSE,
        source_url: "https://github.com/DCMLab/dcml_corpora",
        source: Source::Repos(&[
            Repo { repo: "DCMLab/bach_en_fr_suites", branch: "main", sub: "Bach-Suiten", want: dcml_tables },
            Repo { repo: "DCMLab/bach_solo", branch: "main", sub: "Bach-Solowerke", want: dcml_tables },
            Repo { repo: "DCMLab/corelli", branch: "main", sub: "Corelli", want: dcml_tables },
            Repo { repo: "DCMLab/couperin_concerts", branch: "main", sub: "Couperin-Concerts", want: dcml_tables },
            Repo { repo: "DCMLab/couperin_clavecin", branch: "main", sub: "Couperin-Clavecin", want: dcml_tables },
            Repo { repo: "DCMLab/scarlatti_sonatas", branch: "main", sub: "Scarlatti", want: dcml_tables },
            Repo { repo: "DCMLab/kleine_geistliche_konzerte", branch: "main", sub: "Schuetz-Kleine-geistliche-Konzerte", want: dcml_tables },
            Repo { repo: "DCMLab/frescobaldi_fiori_musicali", branch: "main", sub: "Frescobaldi", want: dcml_tables },
            Repo { repo: "DCMLab/monteverdi_madrigals", branch: "main", sub: "Monteverdi", want: dcml_tables },
            Repo { repo: "DCMLab/pergolesi_stabat_mater", branch: "main", sub: "Pergolesi", want: dcml_tables },
            Repo { repo: "DCMLab/peri_euridice", branch: "main", sub: "Peri", want: dcml_tables },
            Repo { repo: "DCMLab/handel_keyboard", branch: "main", sub: "Haendel", want: dcml_tables },
            Repo { repo: "DCMLab/wf_bach_sonatas", branch: "main", sub: "WF-Bach", want: dcml_tables },
            Repo { repo: "DCMLab/bach_chorales", branch: "main", sub: "Bach-Choraele", want: dcml_tables },
        ]),
        scores: 991,
        download_mb: 37,
        disk_mb: 52,
    },
    Pack {
        id: "dcml-klassik",
        name: "Klassik, analysiert",
        folder: "DCML-Klassik",
        description: "Mozart (alle Klaviersonaten, 54 Sätze) · Beethoven (alle Klaviersonaten, 91 Sätze, und alle Streichquartette, 70 Sätze) · C. P. E. Bach (Klavierwerke, 66 Sätze) · J. C. Bach (Sonaten) · Koželuch (Klaviersonaten) · Pleyel (Streichquartette).",
        group: "dcml",
        format: "DCML-Tabellen",
        license: DCML_LICENSE,
        source_url: "https://github.com/DCMLab/dcml_corpora",
        source: Source::Repos(&[
            Repo { repo: "DCMLab/mozart_piano_sonatas", branch: "main", sub: "Mozart-Klaviersonaten", want: dcml_tables },
            Repo { repo: "DCMLab/beethoven_piano_sonatas", branch: "main", sub: "Beethoven-Klaviersonaten", want: dcml_tables },
            Repo { repo: "DCMLab/ABC", branch: "main", sub: "Beethoven-Streichquartette", want: dcml_tables },
            Repo { repo: "DCMLab/cpe_bach_keyboard", branch: "main", sub: "CPE-Bach", want: dcml_tables },
            Repo { repo: "DCMLab/jc_bach_sonatas", branch: "main", sub: "JC-Bach", want: dcml_tables },
            Repo { repo: "DCMLab/kozeluh_sonatas", branch: "main", sub: "Kozeluch", want: dcml_tables },
            Repo { repo: "DCMLab/pleyel_quartets", branch: "main", sub: "Pleyel", want: dcml_tables },
        ]),
        scores: 365,
        download_mb: 62,
        disk_mb: 85,
    },
    Pack {
        id: "dcml-romantik",
        name: "Romantik, analysiert",
        folder: "DCML-Romantik",
        description: "Chopin (Mazurken) · Schubert (Winterreise) · Robert Schumann (Kinderszenen, Liederkreis) · Clara Schumann (Lieder) · Mendelssohn (Streichquartette) · Liszt (Années de pèlerinage) · Grieg (Lyrische Stücke) · Tschaikowsky (Die Jahreszeiten) · Dvořák (Silhouetten) · Wagner (Ouvertüren) · Mahler (Kindertotenlieder) · Medtner (Märchen).",
        group: "dcml",
        format: "DCML-Tabellen",
        license: DCML_LICENSE,
        source_url: "https://github.com/DCMLab/dcml_corpora",
        source: Source::Repos(&[
            Repo { repo: "DCMLab/chopin_mazurkas", branch: "main", sub: "Chopin-Mazurken", want: dcml_tables },
            Repo { repo: "DCMLab/schubert_winterreise", branch: "main", sub: "Schubert-Winterreise", want: dcml_tables },
            Repo { repo: "DCMLab/schumann_kinderszenen", branch: "main", sub: "Schumann-Kinderszenen", want: dcml_tables },
            Repo { repo: "DCMLab/schumann_liederkreis", branch: "main", sub: "Schumann-Liederkreis", want: dcml_tables },
            Repo { repo: "DCMLab/c_schumann_lieder", branch: "main", sub: "Clara-Schumann-Lieder", want: dcml_tables },
            Repo { repo: "DCMLab/mendelssohn_quartets", branch: "main", sub: "Mendelssohn-Quartette", want: dcml_tables },
            Repo { repo: "DCMLab/liszt_pelerinage", branch: "main", sub: "Liszt-Pelerinage", want: dcml_tables },
            Repo { repo: "DCMLab/grieg_lyric_pieces", branch: "main", sub: "Grieg-Lyrische-Stuecke", want: dcml_tables },
            Repo { repo: "DCMLab/tchaikovsky_seasons", branch: "main", sub: "Tschaikowsky-Jahreszeiten", want: dcml_tables },
            Repo { repo: "DCMLab/dvorak_silhouettes", branch: "main", sub: "Dvorak-Silhouetten", want: dcml_tables },
            Repo { repo: "DCMLab/wagner_overtures", branch: "main", sub: "Wagner-Ouvertueren", want: dcml_tables },
            Repo { repo: "DCMLab/mahler_kindertotenlieder", branch: "main", sub: "Mahler-Kindertotenlieder", want: dcml_tables },
            Repo { repo: "DCMLab/medtner_tales", branch: "main", sub: "Medtner-Maerchen", want: dcml_tables },
        ]),
        scores: 276,
        download_mb: 33,
        disk_mb: 45,
    },
    Pack {
        id: "dcml-20jh",
        name: "Um 1900 und 20. Jahrhundert, analysiert",
        folder: "DCML-20Jh",
        description: "Debussy (Suite bergamasque) · Ravel (Klavierstücke) · Rachmaninow (Klavierstücke) · Bartók (Bagatellen) · Poulenc (Mouvements perpétuels) · Schulhoff (Suite dansante en jazz).",
        group: "dcml",
        format: "DCML-Tabellen",
        license: DCML_LICENSE,
        source_url: "https://github.com/DCMLab/dcml_corpora",
        source: Source::Repos(&[
            Repo { repo: "DCMLab/debussy_suite_bergamasque", branch: "main", sub: "Debussy-Suite-bergamasque", want: dcml_tables },
            Repo { repo: "DCMLab/ravel_piano", branch: "main", sub: "Ravel", want: dcml_tables },
            Repo { repo: "DCMLab/rachmaninoff_piano", branch: "main", sub: "Rachmaninow", want: dcml_tables },
            Repo { repo: "DCMLab/bartok_bagatelles", branch: "main", sub: "Bartok-Bagatellen", want: dcml_tables },
            Repo { repo: "DCMLab/poulenc_mouvements_perpetuels", branch: "main", sub: "Poulenc", want: dcml_tables },
            Repo { repo: "DCMLab/schulhoff_suite_dansante_en_jazz", branch: "main", sub: "Schulhoff", want: dcml_tables },
        ]),
        scores: 54,
        download_mb: 4,
        disk_mb: 6,
    },
];

pub(crate) fn default_root(app: &AppHandle) -> PathBuf {
    // Für Tests und eigene Ablageorte: KLANGWELT_BIBLIOTHEK=<Ordner>
    if let Some(r) = std::env::var_os("KLANGWELT_BIBLIOTHEK").filter(|r| !r.is_empty()) {
        return PathBuf::from(r);
    }
    let p = app.path();
    p.audio_dir()
        .or_else(|_| p.document_dir())
        .or_else(|_| p.app_data_dir())
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("Klangwelt")
        .join("Bibliothek")
}

/// Rang der PDMX-Pakete: Ein größeres enthält die kleineren (sie lesen den Anfang desselben Archivs).
fn pdmx_rank(id: &str) -> Option<u8> {
    match id {
        "pdmx-kostprobe" => Some(1),
        "pdmx-auswahl" => Some(2),
        "pdmx-voll" => Some(3),
        _ => None,
    }
}

/// Enthält eine Bibliothek mit dem Paket `have` schon das Paket `want`?
pub(crate) fn covers(have: &str, want: &str) -> bool {
    have == want || matches!((pdmx_rank(have), pdmx_rank(want)), (Some(a), Some(b)) if a >= b)
}

/// Name eines Pakets mit seiner Sammlung davor („DCML – Klassik, analysiert“).
pub(crate) fn pack_name(id: &str) -> Option<String> {
    let p = PACKS.iter().find(|p| p.id == id)?;
    let short = GROUPS.iter().find(|g| g.id == p.group).and_then(|g| g.name.split(" – ").next()).unwrap_or("");
    Some(if short.is_empty() || p.name.starts_with(short) { p.name.to_string() } else { format!("{short} – {}", p.name) })
}

pub(crate) fn pack_folder(id: &str) -> Option<&'static str> {
    PACKS.iter().find(|p| p.id == id).map(|p| p.folder)
}

/// Paket, dessen Standardordner so heißt.
pub(crate) fn pack_for_folder(folder: &str) -> Option<&'static str> {
    PACKS.iter().find(|p| p.folder.eq_ignore_ascii_case(folder)).map(|p| p.id)
}

/// Liegen Genre/Komponist für alle PDMX-Pakete unter `packs` vor?
pub(crate) fn pdmx_has_meta(root: &Path, packs: &[String]) -> bool {
    packs
        .iter()
        .filter_map(|id| PACKS.iter().find(|p| p.id == id))
        .filter(|p| p.is_pdmx())
        .all(|p| root.join(p.folder).join(pdmx::META_FILE).is_file())
}

/// Liegen die Partituren eines Pakets vollständig im Ordner (Download fertig)?
fn pack_complete(dir: &Path) -> bool {
    any_score(dir) && read_job(dir).is_none_or(|j| j.phase != JobPhase::Laden)
}

#[tauri::command]
pub async fn library_catalog(app: AppHandle, state: State<'_, AppState>) -> CmdResult<Vec<CatalogEntry>> {
    let root = default_root(&app);
    let (lib_name, packs) = lock(&state.library)?.as_ref().map(|l| (l.name.clone(), l.packs.clone())).unwrap_or_default();
    Ok(PACKS
        .iter()
        .map(|p| {
            let folder = root.join(p.folder);
            let g = GROUPS.iter().find(|g| g.id == p.group).unwrap_or(&GROUPS[0]);
            CatalogEntry {
                id: p.id,
                name: p.name,
                description: p.description,
                scores: p.scores,
                download_mb: p.download_mb,
                disk_mb: p.disk_mb,
                license: p.license,
                source_url: p.source_url,
                group: p.group,
                group_name: g.name,
                group_description: g.description,
                format: p.format,
                expert_harmony: p.group == "dcml",
                installed: pack_complete(&folder),
                in_library: packs.iter().any(|have| covers(have, p.id)).then(|| lib_name.clone()),
                folder: folder.display().to_string(),
            }
        })
        .collect())
}

/// Lädt ein Paket aus dem Katalog in `folder` (oder den vorgeschlagenen Ordner),
/// entpackt es als Datenstrom und übernimmt es anschließend in die aktive
/// Bibliothek – alles im Hintergrund. Liegen die Partituren schon im Ordner,
/// entfällt der Download. `withMeta` (Standard: ja) lädt Genre/Komponist aus
/// PDMX.csv dazu.
#[tauri::command]
pub async fn library_download(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    folder: Option<String>,
    with_meta: Option<bool>,
) -> CmdResult<LibraryInfo> {
    start_download(&app, &id, folder.as_deref(), with_meta.unwrap_or(true))?;
    info(&state)
}

/// Lädt für die PDMX-Pakete der aktiven Bibliothek Genre/Komponist nach und
/// baut sie danach neu auf.
#[tauri::command]
pub async fn library_enrich(app: AppHandle, state: State<'_, AppState>) -> CmdResult<LibraryInfo> {
    let packs = lock(&state.library)?.as_ref().map(|l| l.packs.clone()).ok_or("Keine Bibliothek geladen.")?;
    let root = default_root(&app);
    let dirs: Vec<PathBuf> = packs
        .iter()
        .filter_map(|id| PACKS.iter().find(|p| p.id == id))
        .filter(|p| p.is_pdmx())
        .map(|p| root.join(p.folder))
        .filter(|d| d.is_dir() && !d.join(pdmx::META_FILE).is_file())
        .collect();
    let Some(first) = dirs.first() else {
        return Err("Genre und Komponist liegen schon vor (oder die Bibliothek enthält keine PDMX-Partituren).".into());
    };
    {
        let mut s = lock(&state.library_status)?;
        check_idle(&s)?;
        s.download = Some(DownloadProgress {
            name: "Kategorien".into(),
            phase: "Kategorien".into(),
            folder: first.display().to_string(),
            files: 0,
            target: None,
            bytes: 0,
            total_bytes: PDMX_CSV_BYTES,
        });
        s.message = None;
    }
    state.library_cancel.store(false, Ordering::SeqCst);
    emit_info(&app);
    let handle = app.clone();
    std::thread::Builder::new()
        .name("klang-enrich".into())
        .spawn(move || {
            let st = handle.state::<AppState>();
            let mut found = 0;
            let mut error = None;
            for dir in &dirs {
                match fetch_metadata(&handle, dir, "Kategorien") {
                    Ok(n) => found += n,
                    Err(e) => error = Some(e),
                }
            }
            if let Ok(mut s) = st.library_status.lock() {
                s.download = None;
            }
            let result = match error {
                Some(e) if found == 0 => Err(e),
                _ => start_rebuild(&handle, format!("Genre/Komponist für {} Partituren geladen. ", fmt_de(found))),
            };
            if let Err(e) = result {
                if let Ok(mut s) = st.library_status.lock() {
                    s.message = Some(e);
                }
            }
            emit_info(&handle);
        })
        .map_err(|e| e.to_string())?;
    info(&state)
}

/// Liest `PDMX.csv` als Datenstrom und behält die Zeilen der Partituren in `dir`
/// (gespeichert als `pdmx-metadaten.tsv`). Liefert die Zahl der gefundenen Partituren.
fn fetch_metadata(handle: &AppHandle, dir: &Path, name: &str) -> Result<usize, String> {
    let st = handle.state::<AppState>();
    let wanted: std::collections::HashSet<String> = collect_files(dir)
        .map_err(|e| e.to_string())?
        .iter()
        .filter(|p| p.extension().map(|e| e.eq_ignore_ascii_case("mxl")).unwrap_or(false))
        .filter_map(|p| p.file_stem().and_then(|s| s.to_str()).map(str::to_string))
        .collect();
    if wanted.is_empty() {
        return Ok(0);
    }
    if let Ok(mut s) = st.library_status.lock() {
        if let Some(d) = s.download.as_mut() {
            d.phase = "Kategorien".into();
            d.bytes = 0;
            d.total_bytes = PDMX_CSV_BYTES;
            d.target = None;
        }
        s.message = Some(format!("{name}: lade Genre und Komponist (PDMX.csv) …"));
    }
    emit_info(handle);
    let bytes = Arc::new(AtomicU64::new(0));
    // reißt die Verbindung ab, geht es an derselben Stelle weiter
    let mut dl = fetch::ResumingDownload::new(PDMX_CSV_URL, &st.download_child, &st.library_cancel, |pos, n, why| {
        if let Ok(mut s) = st.library_status.lock() {
            s.message = Some(format!("{name}: Verbindung unterbrochen ({why}) – mache bei {} weiter (Verbindung {n}) …", mb_de(pos)));
        }
        emit_info(handle);
    })
    .map_err(|e| e.to_string())?;
    // Fortschritt melden, während gelesen wird (alle 250 ms).
    let ticker = {
        let (bytes, handle) = (bytes.clone(), handle.clone());
        let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let d2 = done.clone();
        let t = std::thread::spawn(move || {
            let st = handle.state::<AppState>();
            while !d2.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(250));
                if let Ok(mut s) = st.library_status.lock() {
                    if let Some(d) = s.download.as_mut() {
                        d.bytes = bytes.load(Ordering::Relaxed);
                    }
                    s.message = None;
                }
                emit_info(&handle);
            }
        });
        (done, t)
    };
    let reader = std::io::BufReader::with_capacity(1 << 20, fetch::Counting::new(&mut dl, bytes.clone()));
    let result = pdmx::filter_metadata(reader, &wanted, &st.library_cancel);
    ticker.0.store(true, Ordering::Relaxed);
    let _ = ticker.1.join();
    // curl beenden (hört auf, sobald alle eigenen Stücke gefunden sind)
    drop(dl);
    let meta = match result {
        Ok(m) => m,
        Err(_) if st.library_cancel.load(Ordering::SeqCst) => return Err(format!("{name}: abgebrochen.")),
        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => return Err(format!("{name}: abgebrochen.")),
        Err(e) => return Err(format!("{name}: Genre/Komponist nicht geladen: {e}")),
    };
    pdmx::save_meta(&dir.join(pdmx::META_FILE), &meta).map_err(|e| e.to_string())?;
    Ok(meta.len())
}

/// Kennungen der Pakete (für den Agenten).
pub fn pack_ids() -> Vec<&'static str> {
    PACKS.iter().map(|p| p.id).collect()
}

/// Ergebnis von [`start_download`]: gleich gestartet oder eingereiht.
pub enum Started {
    Now(PathBuf),
    /// wartet in der Warteschlange (Platz, ab 1)
    Queued(PathBuf, usize),
}

fn find_pack(id: &str) -> CmdResult<&'static Pack> {
    PACKS.iter().find(|p| p.id == id).ok_or_else(|| format!("Unbekanntes Paket: {id} (verfügbar: {})", pack_ids().join(", ")))
}

/// Zielordner eines Auftrags: der angegebene oder der Standardordner des Pakets.
fn item_dir(app: &AppHandle, pack: &Pack, item: &QueuedDownload) -> PathBuf {
    match &item.folder {
        Some(f) => PathBuf::from(f),
        None => default_root(app).join(pack.folder),
    }
}

/// Pakete der Bibliothek `lib_id` (die aktive aus dem Speicher, sonst aus der
/// Liste); None, wenn es sie nicht mehr gibt.
fn library_packs(app: &AppHandle, lib_id: &str) -> Option<Vec<String>> {
    if let Ok(l) = app.state::<AppState>().library.lock() {
        if let Some(l) = l.as_ref().filter(|l| l.id == lib_id) {
            return Some(l.packs.clone());
        }
    }
    libraries::read(&default_root(app)).and_then(|r| r.get(lib_id).map(|e| e.packs.clone()))
}

/// Fehler, wenn die Zielbibliothek das Paket schon enthält (oder fehlt).
fn check_contained(app: &AppHandle, pack: &Pack, item: &QueuedDownload) -> CmdResult<()> {
    let packs = library_packs(app, &item.library).ok_or_else(|| format!("Die Bibliothek „{}“ gibt es nicht mehr.", item.library_name))?;
    if let Some(have) = packs.iter().find(|have| covers(have, pack.id)) {
        let via = if have == pack.id { String::new() } else { format!(" (über „{}“)", pack_name(have).unwrap_or(have.clone())) };
        return Err(format!("„{}“ ist in „{}“ schon enthalten{via}.", pack_name(pack.id).unwrap_or_default(), item.library_name));
    }
    Ok(())
}

/// Startet Download und Übernehmen in die aktive Bibliothek im Hintergrund;
/// Fortschritt über `library-changed`. `with_meta` gilt nur für PDMX
/// (Genre/Komponist aus PDMX.csv); die anderen Sammlungen bringen ihre Angaben
/// selbst mit. Liegen die Partituren schon vollständig im Ordner, entfällt der
/// Download. Läuft gerade etwas (Download, Indizieren, Übernehmen), kommt das
/// Paket in die Warteschlange und startet von selbst, sobald es frei ist.
pub fn start_download(app: &AppHandle, id: &str, folder: Option<&str>, with_meta: bool) -> CmdResult<Started> {
    let state = app.state::<AppState>();
    let pack = find_pack(id)?;
    let (lib_id, lib_name) = active(&state)?;
    let item = QueuedDownload {
        id: pack.id.to_string(),
        name: pack_name(pack.id).unwrap_or_else(|| pack.name.to_string()),
        library: lib_id,
        library_name: lib_name,
        folder: folder.map(str::trim).filter(|f| !f.is_empty()).map(|f| f.trim_matches('"').to_string()),
        with_meta: with_meta && pack.is_pdmx(),
    };
    check_contained(app, pack, &item)?;
    let dir = item_dir(app, pack, &item);
    let present = pack_complete(&dir);
    let mut s = lock(&state.library_status)?;
    // Schon beauftragt (dasselbe Paket oder ein größeres, das es enthält)?
    let same = |q: &QueuedDownload| q.library == item.library && covers(&q.id, pack.id);
    let via = |q: &QueuedDownload| if q.id == pack.id { String::new() } else { format!(" (über „{}“)", q.name) };
    if let Some(q) = s.pipeline.as_ref().filter(|q| same(q)) {
        return Err(format!("„{}“ wird gerade geladen{}.", item.name, via(q)));
    }
    if let Some(q) = s.queue.iter().find(|q| same(q)) {
        return Err(format!("„{}“ wartet schon in der Warteschlange{}.", item.name, via(q)));
    }
    if s.loading {
        return Err("Die Bibliothek wird noch geladen – einen Moment.".into());
    }
    // Warten schon welche, kommt es hinten an – auch in der kurzen Pause zwischen zwei Aufträgen.
    if check_idle(&s).is_err() || !s.queue.is_empty() {
        s.queue.push(item);
        let position = s.queue.len();
        let spawn_runner = !std::mem::replace(&mut s.queue_runner, true);
        drop(s);
        if spawn_runner {
            spawn_queue_runner(app);
        }
        emit_info(app);
        return Ok(Started::Queued(dir, position));
    }
    begin_download(app, pack, item, dir.clone(), present, s)?;
    Ok(Started::Now(dir))
}

/// Arbeitet die Warteschlange ab: Hat die Bibliothek eine halbe Sekunde lang
/// nichts zu tun, startet das nächste Paket. Endet, wenn sie leer ist.
fn spawn_queue_runner(app: &AppHandle) {
    let handle = app.clone();
    let spawned = std::thread::Builder::new().name("klang-warteschlange".into()).spawn(move || {
        let st = handle.state::<AppState>();
        let mut idle_ticks = 0;
        loop {
            std::thread::sleep(Duration::from_millis(250));
            let item = {
                let Ok(mut s) = st.library_status.lock() else { return };
                if s.queue.is_empty() {
                    s.queue_runner = false;
                    return;
                }
                if check_idle(&s).is_err() {
                    idle_ticks = 0;
                    continue;
                }
                // zweimal hintereinander frei: kein Übergang mitten in einem Auftrag
                idle_ticks += 1;
                if idle_ticks < 2 {
                    continue;
                }
                idle_ticks = 0;
                s.queue.remove(0)
            };
            start_queued(&handle, item);
        }
    });
    if spawned.is_err() {
        if let Ok(mut s) = app.state::<AppState>().library_status.lock() {
            s.queue_runner = false;
        }
    }
}

/// Startet ein Paket aus der Warteschlange. Ist es inzwischen enthalten (z. B.
/// über ein größeres Paket davor), wird es mit einer Meldung übersprungen.
fn start_queued(app: &AppHandle, item: QueuedDownload) {
    let st = app.state::<AppState>();
    let checked = find_pack(&item.id).and_then(|pack| check_contained(app, pack, &item).map(|_| pack));
    let pack = match checked {
        Ok(p) => p,
        Err(e) => {
            if let Ok(mut s) = st.library_status.lock() {
                s.message = Some(format!("Warteschlange: „{}“ übersprungen – {e}", item.name));
            }
            emit_info(app);
            return;
        }
    };
    let dir = item_dir(app, pack, &item);
    let present = pack_complete(&dir);
    let Ok(mut s) = st.library_status.lock() else { return };
    if check_idle(&s).is_err() {
        // inzwischen hat etwas anderes begonnen: wieder vorne einreihen
        s.queue.insert(0, item);
        return;
    }
    let name = item.name.clone();
    if let Err(e) = begin_download(app, pack, item, dir, present, s) {
        if let Ok(mut s) = st.library_status.lock() {
            s.message = Some(format!("Warteschlange: „{name}“ – {e}"));
        }
        emit_info(app);
    }
}

/// Setzt den Stand für den Auftrag (bei gehaltener Sperre, damit nichts
/// dazwischenkommt) und startet ihn im Hintergrund.
fn begin_download(app: &AppHandle, pack: &'static Pack, item: QueuedDownload, dir: PathBuf, present: bool, mut s: std::sync::MutexGuard<'_, LibStatus>) -> CmdResult<()> {
    let state = app.state::<AppState>();
    let with_meta = item.with_meta;
    let job = Job { name: pack.name.to_string(), with_meta, phase: JobPhase::Laden, attempts: 0, library: Some(item.library.clone()), pack: Some(pack.id.to_string()) };
    if present {
        s.building = Some((0, 0));
        s.message = Some(format!("{}: Partituren liegen schon im Ordner – übernehme in „{}“ …", pack.name, item.library_name));
    } else {
        let (target, total_bytes, host) = match pack.source {
            Source::Pdmx(limit) => (limit, PDMX_BYTES, "zenodo.org"),
            Source::Repos(_) => (Some(pack.scores), pack.download_mb as u64 * 1_000_000, "github.com"),
        };
        s.download = Some(DownloadProgress {
            name: pack.name.into(),
            phase: "Partituren".into(),
            folder: dir.display().to_string(),
            files: 0,
            target,
            bytes: 0,
            total_bytes,
        });
        s.message = Some(format!("{}: verbinde mit {host} …", pack.name));
    }
    s.pipeline = Some(item);
    drop(s);
    state.library_cancel.store(false, Ordering::SeqCst);
    emit_info(app);
    let handle = app.clone();
    let name = pack.name;
    let spawned = std::thread::Builder::new()
        .name("klang-download".into())
        .spawn(move || {
            let _running = PipelineGuard(handle.clone());
            let st = handle.state::<AppState>();
            if present {
                // nur übernehmen (Genre/Komponist fehlen ggf. noch)
                let job = Job { phase: if with_meta { JobPhase::Metadaten } else { JobPhase::Indizieren }, ..job };
                write_job(&handle, &dir, &job);
                let fetch_meta = with_meta && !dir.join(pdmx::META_FILE).is_file();
                finish_pipeline(&handle, &dir, &job, String::new(), fetch_meta);
                if let Ok(mut s) = st.library_status.lock() {
                    s.building = None;
                }
                return;
            }
            // Auftrag vermerken: wird die App geschlossen, geht es beim nächsten Start weiter.
            if std::fs::create_dir_all(&dir).is_ok() {
                write_job(&handle, &dir, &job);
            }
            let result = match pack.source {
                Source::Pdmx(limit) => download_pack(&handle, &dir, name, limit),
                Source::Repos(repos) => download_repos(&handle, &dir, pack, repos),
            };
            match result {
                Ok(stats) => {
                    let mut what = if stats.existing == stats.files {
                        format!("{name}: {} Dateien waren schon da. ", stats.files)
                    } else {
                        format!("{name}: {} Dateien geladen. ", stats.files)
                    };
                    match stats.resumed {
                        0 => {}
                        1 => what.push_str("Die Verbindung riss einmal ab und wurde fortgesetzt. "),
                        n => what.push_str(&format!("Die Verbindung riss {n}-mal ab und wurde jeweils fortgesetzt. ")),
                    }
                    // Partituren komplett: ab hier wird beim nächsten Start ohne Download fortgesetzt
                    set_phase(&handle, &dir, if with_meta { JobPhase::Metadaten } else { JobPhase::Indizieren });
                    finish_pipeline(&handle, &dir, &job, what, true);
                }
                Err(e) => {
                    if st.library_cancel.load(Ordering::SeqCst) {
                        set_phase(&handle, &dir, JobPhase::Abgebrochen);
                    }
                    if let Ok(mut s) = st.library_status.lock() {
                        s.download = None;
                        s.message = Some(e);
                    }
                }
            }
        });
    if let Err(e) = spawned {
        if let Ok(mut s) = state.library_status.lock() {
            s.download = None;
            s.building = None;
            s.pipeline = None;
        }
        emit_info(app);
        return Err(e.to_string());
    }
    Ok(())
}

/// Nimmt ein wartendes Paket aus der Warteschlange (`library`: nur das für
/// diese Bibliothek); ohne `id` alle.
pub fn dequeue(app: &AppHandle, id: Option<&str>, library: Option<&str>) -> CmdResult<usize> {
    let st = app.state::<AppState>();
    let removed = {
        let mut s = lock(&st.library_status)?;
        let before = s.queue.len();
        s.queue.retain(|q| id.is_some_and(|id| q.id != id) || library.is_some_and(|l| q.library != l));
        before - s.queue.len()
    };
    emit_info(app);
    Ok(removed)
}

/// Nimmt ein wartendes Paket aus der Warteschlange; ohne `id` alle.
#[tauri::command]
pub async fn library_dequeue(app: AppHandle, state: State<'_, AppState>, id: Option<String>, library: Option<String>) -> CmdResult<LibraryInfo> {
    dequeue(&app, id.as_deref(), library.as_deref())?;
    info(&state)
}

/// Lädt die passenden Dateien einer GitHub-Sammlung (läuft im Hintergrund-Thread).
fn download_repos(handle: &AppHandle, dir: &Path, pack: &Pack, repos: &[Repo]) -> Result<ExtractStats, String> {
    let st = handle.state::<AppState>();
    let name = pack.name;
    std::fs::create_dir_all(dir).map_err(|e| format!("Ordner {} lässt sich nicht anlegen: {e}", dir.display()))?;
    let _ = std::fs::write(
        dir.join("QUELLE.txt"),
        format!(
            "{name}\n\n{}\n\nQuelle: {}\nLizenz: {}\n\nHeruntergeladen und indiziert von Klangwelt.\n",
            pack.description,
            repos.iter().map(|r| format!("https://github.com/{}", r.repo)).collect::<Vec<_>>().join(", "),
            pack.license
        ),
    );
    // Dateilisten
    let mut files: Vec<fetch::RemoteFile> = Vec::new();
    // Die GitHub-API erlaubt ohne Anmeldung rund 60 Abfragen pro Stunde – ein
    // Epochen-Paket braucht bis zu 13. Ist die Grenze erreicht (oder GitHub
    // nicht erreichbar), gilt die mitgelieferte Liste (sammlungen.txt).
    let mut api_ok = true;
    for r in repos {
        if st.library_cancel.load(Ordering::SeqCst) {
            return Err(format!("{name}: Download abgebrochen."));
        }
        if let Ok(mut s) = st.library_status.lock() {
            s.message = Some(format!("{name}: lade die Dateiliste von {} …", r.repo));
        }
        emit_info(handle);
        let live = if api_ok { fetch::github_tree(r.repo, r.branch) } else { Err(std::io::Error::other("übersprungen")) };
        let tree = match live {
            Ok(t) => t,
            Err(e) => {
                api_ok = false;
                fetch::manifest_files(SAMMLUNGEN, r.repo).ok_or_else(|| format!("{name}: {e}"))?
            }
        };
        let sub = Path::new(r.sub);
        // Komponist der Sammlung für Partituren, die ihn nicht selbst nennen
        if let Some(c) = repo_composer(r.repo) {
            let d = dir.join(sub);
            if std::fs::create_dir_all(&d).is_ok() {
                let _ = std::fs::write(d.join(klang_music::score::COMPOSER_FILE), c);
            }
        }
        files.extend(tree.into_iter().filter(|(p, _)| (r.want)(p)).map(|(p, size)| fetch::RemoteFile {
            url: fetch::github_raw_url(r.repo, r.branch, &p),
            rel: sub.join(fetch::ascii_path(&p)),
            size,
        }));
    }
    if files.is_empty() {
        return Err(format!("{name}: keine passenden Dateien in der Quelle gefunden."));
    }
    let total_bytes: u64 = files.iter().map(|f| f.size).sum();
    if let Ok(mut s) = st.library_status.lock() {
        if let Some(d) = s.download.as_mut() {
            d.target = Some(files.len());
            d.total_bytes = total_bytes;
        }
        s.message = None;
    }
    emit_info(handle);
    let result = fetch::fetch_files(&files, dir, &st.library_cancel, &st.download_child, |s| {
        if let Ok(mut status) = st.library_status.lock() {
            if let Some(d) = status.download.as_mut() {
                d.files = s.files;
                d.bytes = s.bytes;
            }
            status.message = None;
        }
        emit_info(handle);
    });
    let stats = match result {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => return Err(format!("{name}: Download abgebrochen.")),
        Err(e) => return Err(format!("{name}: Download fehlgeschlagen: {e}")),
    };
    // Einzelne Ausfälle hinnehmen, viele nicht (nächster Versuch lädt nur, was fehlt).
    if stats.failed > 0 && stats.failed * 10 > files.len() {
        return Err(format!(
            "{name}: {} von {} Dateien nicht geladen (z. B. {}) – „Herunterladen“ versucht es erneut.",
            stats.failed,
            files.len(),
            stats.failed_paths.join(", ")
        ));
    }
    write_collection_meta(dir);
    Ok(ExtractStats { files: stats.files, existing: stats.existing, bytes_written: stats.bytes, ..Default::default() })
}

/// Genre „Klassik“ für alle Partituren einer Sammlung – im selben Format wie
/// die PDMX-Angaben, damit Baum und Bibliotheksinfo sie finden. Den Komponisten
/// liefert die Partitur selbst.
fn write_collection_meta(dir: &Path) {
    let Ok(list) = collect_files(dir) else { return };
    let meta: std::collections::HashMap<String, pdmx::PdmxMeta> = list
        .iter()
        .filter_map(|p| p.file_stem().and_then(|s| s.to_str()).map(str::to_string))
        .map(|stem| (stem, pdmx::PdmxMeta { genres: vec!["classical".into()], ..Default::default() }))
        .collect();
    let _ = pdmx::save_meta(&dir.join(pdmx::META_FILE), &meta);
}

/// Download + Entpacken (läuft im Hintergrund-Thread).
fn download_pack(handle: &AppHandle, dir: &Path, name: &str, limit: Option<usize>) -> Result<ExtractStats, String> {
    let st = handle.state::<AppState>();
    std::fs::create_dir_all(dir).map_err(|e| format!("Ordner {} lässt sich nicht anlegen: {e}", dir.display()))?;
    let _ = std::fs::write(
        dir.join("QUELLE.txt"),
        format!(
            "{name}\n\nQuelle: PDMX – A Large-Scale Public Domain MusicXML Dataset for Symbolic Music Processing\n\
             (Long, Novack, Berg-Kirkpatrick, McAuley 2024), {PDMX_RECORD}\n\
             Lizenz: {PDMX_LICENSE}\nBei Verwendung bitte das Paper zitieren (siehe https://github.com/pnlong/PDMX).\n\
             Heruntergeladen und indiziert von Klangwelt.\n"
        ),
    );
    let bytes = Arc::new(AtomicU64::new(0));
    // Ein einziger Datenstrom über 1,9 GB: Reißt die Verbindung ab, geht es an
    // derselben Stelle weiter (HTTP-Range) – das Entpacken merkt davon nichts.
    // Für Tests: KLANGWELT_PDMX_URL=<Archiv auf einem lokalen Server>
    let url = std::env::var("KLANGWELT_PDMX_URL").ok().filter(|u| !u.is_empty()).unwrap_or_else(|| PDMX_MXL_URL.to_string());
    let mut dl = fetch::ResumingDownload::new(&url, &st.download_child, &st.library_cancel, |pos, n, why| {
        if let Ok(mut s) = st.library_status.lock() {
            s.message = Some(format!("{name}: Verbindung unterbrochen ({why}) – mache bei {} weiter (Verbindung {n}) …", mb_de(pos)));
        }
        emit_info(handle);
    })
    .map_err(|e| e.to_string())?;
    let files = std::cell::Cell::new(0usize);
    let mut last = Instant::now();
    let result = fetch::extract_scores(fetch::Counting::new(&mut dl, bytes.clone()), dir, Some("mxl"), limit, &st.library_cancel, |s| {
        files.set(s.files);
        if last.elapsed() < Duration::from_millis(200) {
            return;
        }
        last = Instant::now();
        if let Ok(mut status) = st.library_status.lock() {
            if let Some(d) = status.download.as_mut() {
                d.files = s.files;
                d.bytes = bytes.load(Ordering::Relaxed);
            }
            status.message = None;
        }
        emit_info(handle);
    });
    let resumed = dl.resumed();
    // curl beenden (bei Kostproben bewusst vor dem Ende des Archivs)
    drop(dl);
    match result {
        Ok(stats) => Ok(ExtractStats { resumed, ..stats }),
        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => Err(format!("{name}: Download abgebrochen.")),
        Err(e) => Err(format!(
            "{name}: Download nach {} Partituren abgebrochen ({e}) – „Herunterladen“ macht weiter, vorhandene Partituren werden übersprungen.",
            fmt_de(files.get())
        )),
    }
}

/// Bytes als „812 MB“ bzw. „1,4 GB“.
fn mb_de(bytes: u64) -> String {
    if bytes >= 1_000_000_000 {
        format!("{:.1} GB", bytes as f64 / 1e9).replace('.', ",")
    } else {
        format!("{} MB", bytes / 1_000_000)
    }
}

/// Bricht einen laufenden Download oder Indexlauf ab.
#[tauri::command]
pub async fn library_cancel(state: State<'_, AppState>) -> CmdResult<()> {
    state.library_cancel.store(true, Ordering::SeqCst);
    if let Some(c) = lock(&state.download_child)?.as_mut() {
        let _ = c.kill();
    }
    Ok(())
}

