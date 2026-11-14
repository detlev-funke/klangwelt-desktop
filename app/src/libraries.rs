//! Libraries: each is exactly one index file (`Indizes/<Name>.kwix` in the
//! library folder); only the active one is ever searched. Which libraries
//! exist, what they contain and which is active is stored in `bibliotheken.json`
//! in the library folder – at startup the app loads the active one, however it
//! was started. New scores (packages, folders, files) are indexed on their own
//! and merged into the index file ([`merge_into`]); what the library already
//! has is skipped.
//!
//! On the first start with this version, "Standard" is built from the old
//! per-package-folder indexes ([`migrate`]), without re-reading a single score.

use crate::library::{covers, default_root, emit_info, pack_folder, pack_for_folder, pack_name, pack_name_untranslated, pdmx_has_meta};
use crate::state::{lock, AppState, CmdResult, Library};
use klang_i18n::{tr, trn};
use klang_music::diskindex::{extra_path, merge, AnyIndex, IndexWriter, MergeStats};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State};

pub const STANDARD: &str = "standard";
const STANDARD_NAME: &str = "Standard";
const REGISTRY: &str = "bibliotheken.json";
const INDEX_DIR: &str = "Indizes";
/// Per-package-folder index from the time before the library list.
const OLD_INDEX: &str = "klangwelt-bibliothek.kwix";

/// Read–modify–write of `bibliotheken.json` only one at a time.
static REGISTRY_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct LibEntry {
    pub id: String,
    pub name: String,
    /// Index file in the `Indizes` folder
    pub file: String,
    /// Contained packages from the catalog
    #[serde(default)]
    pub packs: Vec<String>,
    /// Added folders and files (for "Re-index")
    #[serde(default)]
    pub paths: Vec<String>,
    #[serde(default)]
    pub scores: usize,
    #[serde(default)]
    pub voices: usize,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Registry {
    pub active: String,
    pub libraries: Vec<LibEntry>,
}

impl Registry {
    pub fn get(&self, id: &str) -> Option<&LibEntry> {
        self.libraries.iter().find(|l| l.id == id)
    }

    fn get_mut(&mut self, id: &str) -> Option<&mut LibEntry> {
        self.libraries.iter_mut().find(|l| l.id == id)
    }
}

pub fn index_dir(root: &Path) -> PathBuf {
    root.join(INDEX_DIR)
}

pub fn read(root: &Path) -> Option<Registry> {
    serde_json::from_slice(&std::fs::read(root.join(REGISTRY)).ok()?).ok()
}

fn write(root: &Path, reg: &Registry) -> Result<(), String> {
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let tmp = root.join(format!("{REGISTRY}.neu"));
    std::fs::write(&tmp, serde_json::to_vec_pretty(reg).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    rename_retry(&tmp, &root.join(REGISTRY)).map_err(|e| format!("{REGISTRY}: {e}"))
}

/// Reads, modifies and saves the list (under the lock).
fn update<T>(handle: &AppHandle, f: impl FnOnce(&mut Registry) -> Result<T, String>) -> Result<T, String> {
    let _g = REGISTRY_LOCK.lock().map_err(|_| tr!("Library list locked"))?;
    let root = default_root(handle);
    let mut reg = read(&root).ok_or_else(|| tr!("The library list is still missing (it is created at startup)."))?;
    let out = f(&mut reg)?;
    write(&root, &reg)?;
    Ok(out)
}

/// Rename with retry (Windows sometimes releases files only shortly afterwards).
pub(crate) use klang_app::vfs::rename_retry;

/// Empty index file (a new library always has one).
fn write_empty(path: &Path) -> Result<(), String> {
    IndexWriter::new(&path.with_extension("kwix-tmp"))
        .and_then(|w| w.finish(path, &AtomicBool::new(false)))
        .map(|_| ())
        .map_err(|e| format!("{}: {e}", path.display()))
}

/// Windows: `\\?\C:\…` → `C:\…`.
fn plain_path(s: String) -> String {
    match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => rest.to_string(),
        _ => s,
    }
}

/// File name from a library name (without special characters).
fn slug(name: &str) -> String {
    let mut s = String::new();
    for c in name.chars() {
        match c {
            'ä' => s.push_str("ae"),
            'ö' => s.push_str("oe"),
            'ü' => s.push_str("ue"),
            'Ä' => s.push_str("Ae"),
            'Ö' => s.push_str("Oe"),
            'Ü' => s.push_str("Ue"),
            'ß' => s.push_str("ss"),
            c if c.is_ascii_alphanumeric() => s.push(c),
            _ if !s.ends_with('-') && !s.is_empty() => s.push('-'),
            _ => {}
        }
    }
    let s = s.trim_end_matches('-').to_string();
    if s.is_empty() {
        "Bibliothek".into()
    } else {
        s
    }
}

/// Identifier and file name for a new library that does not exist yet.
fn unique_slug(name: &str, reg: &Registry, dir: &Path) -> String {
    let base = slug(name);
    let mut s = base.clone();
    let mut n = 2;
    while reg.libraries.iter().any(|l| l.id.eq_ignore_ascii_case(&s)) || dir.join(format!("{s}.kwix")).exists() {
        s = format!("{base}-{n}");
        n += 1;
    }
    s
}

/// The other of a library's two files (`X.kwix` ↔ `X.neu.kwix`): merging goes
/// there while the current one is still being searched.
pub fn other_file(file: &str) -> String {
    match file.strip_suffix(".neu.kwix") {
        Some(stem) => format!("{stem}.kwix"),
        None => format!("{}.neu.kwix", file.strip_suffix(".kwix").unwrap_or(file)),
    }
}

// ---------------------------------------------------------------- Loading

fn set_status(handle: &AppHandle, f: impl FnOnce(&mut crate::library::LibStatus)) {
    if let Ok(mut s) = handle.state::<AppState>().library_status.lock() {
        f(&mut s);
    }
    emit_info(handle);
}

fn library_for(handle: &AppHandle, entry: &LibEntry, path: PathBuf, index: AnyIndex) -> Library {
    let root = default_root(handle);
    Library {
        id: entry.id.clone(),
        name: entry.name.clone(),
        path: path.display().to_string(),
        index,
        packs: entry.packs.clone(),
        has_meta: pdmx_has_meta(&root, &entry.packs),
    }
}

/// Loads library `id` and makes it the active one (in the list too).
pub fn activate(handle: &AppHandle, id: &str) -> Result<(), String> {
    let root = default_root(handle);
    let reg = read(&root).ok_or_else(|| tr!("The library list is still missing."))?;
    let entry = reg.get(id).cloned().ok_or_else(|| tr!("Unknown library: {id}", id = id))?;
    let path = index_dir(&root).join(&entry.file);
    let index = AnyIndex::load(&path)
        .map_err(|e| tr!("The library \"{name}\" can't be loaded ({path}): {error}", name = entry.name, path = path.display(), error = e))?;
    let lib = library_for(handle, &entry, path, index);
    *lock(&handle.state::<AppState>().library)? = Some(lib);
    if reg.active != id {
        update(handle, |r| {
            r.active = id.to_string();
            Ok(())
        })?;
    }
    Ok(())
}

/// At program start (in the background): create the library list or build it
/// from the old indexes, load the active library, then resume interrupted
/// jobs.
pub fn startup(handle: &AppHandle) {
    set_status(handle, |s| s.loading = true);
    let fallback = handle.clone();
    let handle = handle.clone();
    let spawned = std::thread::Builder::new().name("klang-bibliotheken".into()).spawn(move || {
        let root = default_root(&handle);
        let mut note: Option<String> = None;
        if read(&root).is_none() {
            match migrate(&handle, &root) {
                Ok(msg) => note = Some(msg),
                Err(e) => note = Some(tr!("Setting up the libraries failed: {error}", error = e)),
            }
        }
        if let Some(reg) = read(&root) {
            let result = activate(&handle, &reg.active).or_else(|e| {
                // the active one is broken or missing: take "Standard"
                if reg.active != STANDARD && activate(&handle, STANDARD).is_ok() {
                    Ok(())
                } else {
                    Err(e)
                }
            });
            if let Err(e) = result {
                note = Some(note.map(|n| format!("{n} {e}")).unwrap_or(e));
            }
        }
        set_status(&handle, |s| {
            s.loading = false;
            if note.is_some() {
                s.message = note;
            }
        });
        crate::library::resume_pending(&handle);
    });
    if let Err(e) = spawned {
        set_status(&fallback, |s| {
            s.loading = false;
            s.message = Some(tr!("Library not loaded: {error}", error = e));
        });
    }
}

/// Number with thousands separators (253.570).
pub fn fmt_de(n: usize) -> String {
    let d = n.to_string();
    let mut out = String::new();
    for (i, c) in d.chars().enumerate() {
        if i > 0 && (d.len() - i) % 3 == 0 {
            out.push('.');
        }
        out.push(c);
    }
    out
}

/// Group and decimal separator of the chosen language (like `toLocaleString`
/// in the UI): 253,570 / 253.570 / 253 570.
pub fn separators() -> (char, char) {
    match klang_i18n::language().as_str() {
        "de" | "nl" | "es" | "it" => ('.', ','),
        "fr" => ('\u{202f}', ','),
        "pl" => ('\u{a0}', ','),
        _ => (',', '.'),
    }
}

/// Number with the group separator of the chosen language (for messages).
pub fn fmt_num(n: usize) -> String {
    let group = separators().0;
    if group == '.' {
        fmt_de(n)
    } else {
        fmt_de(n).replace('.', &group.to_string())
    }
}

// ---------------------------------------------------------------- Merging

/// Installs a finished index file as the new state of library `id`: if it is
/// active, searching switches to it right away; the old file disappears.
/// `edit` enters packages, paths and counts into the list.
pub fn install(handle: &AppHandle, id: &str, new_path: &Path, edit: impl FnOnce(&mut LibEntry)) -> Result<(), String> {
    let st = handle.state::<AppState>();
    let root = default_root(handle);
    let dir = index_dir(&root);
    let active_now = lock(&st.library)?.as_ref().is_some_and(|l| l.id == id);
    // Load before locking (a large library takes about a second)
    let mut fresh = if active_now { Some(AnyIndex::load(new_path).map_err(|e| e.to_string())?) } else { None };
    update(handle, |reg| {
        let entry = reg.get_mut(id).ok_or_else(|| tr!("Library {id} no longer exists", id = id))?;
        let old = dir.join(&entry.file);
        let new_name = new_path.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string();
        let canonical = new_name.strip_suffix(".neu.kwix").map(|s| format!("{s}.kwix"));
        edit(entry);
        let mut lib = lock(&st.library)?;
        let is_active = lib.as_ref().is_some_and(|l| l.id == id);
        if is_active {
            let index = match fresh.take() {
                Some(i) => i,
                None => AnyIndex::load(new_path).map_err(|e| e.to_string())?,
            };
            // releases the old file
            *lib = Some(library_for(handle, entry, new_path.to_path_buf(), index));
        }
        let mut final_path = new_path.to_path_buf();
        match canonical {
            // new state is in X.neu.kwix → move to X.kwix (replaces the old one)
            Some(c) => {
                let target = dir.join(&c);
                if rename_retry(new_path, &target).is_ok() {
                    final_path = target;
                } else {
                    let _ = std::fs::remove_file(&old);
                }
            }
            // new state is already in X.kwix → remove X.neu.kwix
            None => {
                if old != final_path {
                    let _ = std::fs::remove_file(&old);
                }
            }
        }
        if let Some(l) = lib.as_mut().filter(|l| l.id == id) {
            l.path = final_path.display().to_string();
        }
        entry.file = final_path.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string();
        Ok(())
    })
}

/// Merges the index `new` into library `id` (scores it already has are
/// skipped), records packages and paths and installs the result. Runs on a
/// job's background thread; `library_cancel` aborts without changing anything.
pub fn merge_into(handle: &AppHandle, id: &str, new: &Path, packs: &[String], paths: &[String]) -> Result<MergeStats, String> {
    let st = handle.state::<AppState>();
    let root = default_root(handle);
    let dir = index_dir(&root);
    let entry = read(&root).and_then(|r| r.get(id).cloned()).ok_or_else(|| tr!("Library {id} doesn't exist", id = id))?;
    let current = dir.join(&entry.file);
    let target = dir.join(other_file(&entry.file));
    set_status(handle, |s| {
        s.merging = Some(0.0);
        s.message = Some(tr!("Adding to \"{library}\" …", library = entry.name));
    });
    let result = (|| -> Result<MergeStats, String> {
        let base = AnyIndex::load(&current).map_err(|e| format!("{}: {e}", current.display()))?;
        let add = AnyIndex::load(new).map_err(|e| format!("{}: {e}", new.display()))?;
        let last = std::cell::Cell::new(Instant::now());
        let progress = |p: f32| {
            if last.get().elapsed() > Duration::from_millis(200) {
                last.set(Instant::now());
                set_status(handle, |s| {
                    s.merging = Some(p);
                    s.message = None;
                });
            }
        };
        merge(&[&base, &add], &target, true, &progress, &st.library_cancel).map_err(|e| {
            if e.kind() == std::io::ErrorKind::Interrupted {
                "abgebrochen".to_string()
            } else {
                e.to_string()
            }
        })
    })();
    set_status(handle, |s| s.merging = None);
    let stats = result?;
    install(handle, id, &target, |e| {
        for p in packs {
            if !e.packs.contains(p) {
                e.packs.push(p.clone());
            }
        }
        for p in paths {
            if !e.paths.contains(p) {
                e.paths.push(p.clone());
            }
        }
        e.scores = stats.scores as usize;
        e.voices = stats.docs as usize;
    })?;
    Ok(stats)
}

// ---------------------------------------------------------------- Managing

/// A library for the UI and the agent.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LibView {
    id: String,
    name: String,
    scores: usize,
    voices: usize,
    /// Names of the contained packages
    packs: Vec<String>,
    paths: Vec<String>,
    active: bool,
    standard: bool,
    /// Size of the index file
    bytes: u64,
}

pub fn list(handle: &AppHandle) -> Vec<LibView> {
    let root = default_root(handle);
    let Some(reg) = read(&root) else { return Vec::new() };
    let dir = index_dir(&root);
    reg.libraries
        .iter()
        .map(|l| LibView {
            id: l.id.clone(),
            name: l.name.clone(),
            scores: l.scores,
            voices: l.voices,
            packs: l.packs.iter().map(|p| pack_name(p).unwrap_or_else(|| p.clone())).collect(),
            paths: l.paths.clone(),
            active: l.id == reg.active,
            standard: l.id == STANDARD,
            bytes: std::fs::metadata(dir.join(&l.file)).map(|m| m.len()).unwrap_or(0),
        })
        .collect()
}

/// Identifier for an agent's specification (identifier or name).
pub fn resolve(handle: &AppHandle, key: &str) -> Result<String, String> {
    let reg = read(&default_root(handle)).ok_or_else(|| tr!("The library list is still missing."))?;
    let key = key.trim();
    reg.libraries
        .iter()
        .find(|l| l.id == key)
        .or_else(|| reg.libraries.iter().find(|l| l.name.eq_ignore_ascii_case(key)))
        .map(|l| l.id.clone())
        .ok_or_else(|| {
            tr!(
                "No library \"{name}\" (available: {libraries})",
                name = key,
                libraries = reg.libraries.iter().map(|l| l.name.as_str()).collect::<Vec<_>>().join(", ")
            )
        })
}

fn busy_text(st: &AppState) -> Option<String> {
    let s = st.library_status.lock().ok()?;
    (s.building.is_some() || s.download.is_some() || s.adding || s.merging.is_some() || s.loading || s.pipeline.is_some())
        .then(|| tr!("Downloading, indexing or adding is in progress – please wait or cancel."))
}

/// Creates an empty library (does not become active).
pub fn create(handle: &AppHandle, name: &str) -> Result<LibEntry, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(tr!("Please enter a name."));
    }
    let dir = index_dir(&default_root(handle));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    update(handle, |reg| {
        if reg.libraries.iter().any(|l| l.name.eq_ignore_ascii_case(name)) {
            return Err(tr!("A library named \"{name}\" already exists.", name = name));
        }
        let s = unique_slug(name, reg, &dir);
        let file = format!("{s}.kwix");
        write_empty(&dir.join(&file))?;
        let entry = LibEntry { id: s.to_lowercase(), name: name.to_string(), file, ..Default::default() };
        reg.libraries.push(entry.clone());
        Ok(entry)
    })
}

pub fn rename(handle: &AppHandle, id: &str, name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(tr!("Please enter a name."));
    }
    update(handle, |reg| {
        if reg.libraries.iter().any(|l| l.id != id && l.name.eq_ignore_ascii_case(name)) {
            return Err(tr!("A library named \"{name}\" already exists.", name = name));
        }
        reg.get_mut(id).ok_or_else(|| tr!("Unknown library: {id}", id = id))?.name = name.to_string();
        Ok(())
    })?;
    let st = handle.state::<AppState>();
    if let Some(l) = lock(&st.library)?.as_mut().filter(|l| l.id == id) {
        l.name = name.to_string();
    }
    Ok(())
}

/// Deletes a library: only its index file, never scores. "Standard" stays; if
/// it was active, "Standard" becomes active.
pub fn delete(handle: &AppHandle, id: &str) -> Result<(), String> {
    if id == STANDARD {
        return Err(tr!("The \"Standard\" library can't be deleted."));
    }
    let st = handle.state::<AppState>();
    if let Some(b) = busy_text(&st) {
        return Err(b);
    }
    let root = default_root(handle);
    let reg = read(&root).ok_or_else(|| tr!("The library list is still missing."))?;
    let entry = reg.get(id).cloned().ok_or_else(|| tr!("Unknown library: {id}", id = id))?;
    if reg.active == id || lock(&st.library)?.as_ref().is_some_and(|l| l.id == id) {
        activate(handle, STANDARD)?;
    }
    update(handle, |r| {
        r.libraries.retain(|l| l.id != id);
        Ok(())
    })?;
    let dir = index_dir(&root);
    let _ = std::fs::remove_file(dir.join(&entry.file));
    let _ = std::fs::remove_file(dir.join(other_file(&entry.file)));
    Ok(())
}

// ---------------------------------------------------------------- Migration

/// First start with a library list: merge "Standard" from the old per-package-
/// folder indexes (duplicates once). If the full PDMX is included, the sample
/// and selection (its subsets) become libraries of their own. The old index
/// files disappear afterwards. Returns the message for it.
fn migrate(handle: &AppHandle, root: &Path) -> Result<String, String> {
    let dir = index_dir(root);
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    // (folder, index file, size, package)
    let mut found: Vec<(PathBuf, PathBuf, u64, Option<&'static str>)> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(root) {
        for e in rd.flatten() {
            let folder = e.path();
            let idx = folder.join(OLD_INDEX);
            if folder.is_dir() && idx.is_file() {
                let size = std::fs::metadata(&idx).map(|m| m.len()).unwrap_or(0);
                let pack = folder.file_name().and_then(|n| n.to_str()).and_then(pack_for_folder);
                found.push((folder, idx, size, pack));
            }
        }
    }
    let full_pdmx = found.iter().any(|f| f.3 == Some("pdmx-voll"));
    let (own, mut rest): (Vec<_>, Vec<_>) = found.into_iter().partition(|f| full_pdmx && f.3.is_some_and(|p| p != "pdmx-voll" && covers("pdmx-voll", p)));
    let mut reg = Registry { active: STANDARD.into(), libraries: Vec::new() };

    // Subsets of the full PDMX as libraries of their own (only move the file)
    for (_, idx, _, pack) in &own {
        let pack = pack.unwrap_or_default();
        // untranslated: the saved name and the id must not depend on the language
        let name = pack_name_untranslated(pack).unwrap_or_else(|| pack.to_string());
        let s = unique_slug(&name, &reg, &dir);
        let file = format!("{s}.kwix");
        let target = dir.join(&file);
        let moved = if extra_path(idx).is_file() {
            // with addition: both into one file
            let index = AnyIndex::load(idx).map_err(|e| e.to_string())?;
            merge(&[&index], &target, true, &|_| {}, &AtomicBool::new(false)).map(|_| ()).map_err(|e| e.to_string())
        } else {
            rename_retry(idx, &target).map_err(|e| e.to_string())
        };
        if let Err(e) = moved {
            return Err(format!("{name}: {e}"));
        }
        let index = AnyIndex::load(&target).map_err(|e| format!("{name}: {e}"))?;
        reg.libraries.push(LibEntry {
            id: s.to_lowercase(),
            name,
            file,
            packs: vec![pack.to_string()],
            paths: Vec::new(),
            scores: index.score_count(),
            voices: index.doc_count(),
        });
    }

    // Standard: everything else, largest first (copied almost unchanged)
    rest.sort_by(|a, b| b.2.cmp(&a.2));
    let target = dir.join(format!("{STANDARD_NAME}.kwix"));
    let mut standard = LibEntry { id: STANDARD.into(), name: STANDARD_NAME.into(), file: format!("{STANDARD_NAME}.kwix"), ..Default::default() };
    let from: Vec<String> = rest.iter().filter_map(|f| f.0.file_name().map(|n| n.to_string_lossy().into_owned())).collect();
    if rest.is_empty() {
        write_empty(&target)?;
    } else {
        set_status(handle, |s| {
            s.merging = Some(0.0);
            s.message = Some(tr!("Setting up the library \"{name}\" (from {folders}) …", name = STANDARD_NAME, folders = from.join(", ")));
        });
        let result = (|| -> Result<MergeStats, String> {
            let loaded: Vec<AnyIndex> = rest.iter().map(|f| AnyIndex::load(&f.1).map_err(|e| format!("{}: {e}", f.1.display()))).collect::<Result<_, _>>()?;
            for (f, index) in rest.iter().zip(&loaded) {
                match f.3 {
                    Some(p) => standard.packs.push(p.to_string()),
                    None => standard.paths.push(f.0.display().to_string()),
                }
                // (old addition files stored paths with \\?\ in front)
                standard.paths.extend(index.extra_sources().into_iter().map(plain_path));
            }
            let refs: Vec<&AnyIndex> = loaded.iter().collect();
            let last = std::cell::Cell::new(Instant::now());
            let progress = |p: f32| {
                if last.get().elapsed() > Duration::from_millis(200) {
                    last.set(Instant::now());
                    set_status(handle, |s| s.merging = Some(p));
                }
            };
            merge(&refs, &target, true, &progress, &AtomicBool::new(false)).map_err(|e| e.to_string())
        })();
        set_status(handle, |s| s.merging = None);
        let stats = result?;
        standard.scores = stats.scores as usize;
        standard.voices = stats.docs as usize;
    }
    // own folders only once, files inside them not additionally
    let folders: Vec<String> = standard.paths.iter().filter(|p| Path::new(p).is_dir()).cloned().collect();
    standard.paths.retain(|p| Path::new(p).is_dir() || !folders.iter().any(|f| Path::new(p).starts_with(f)));
    standard.paths.dedup();
    let (n, count, folders) = (standard.scores, fmt_num(standard.scores), from.join(", "));
    let own = reg.libraries.iter().map(|l| l.name.as_str()).collect::<Vec<_>>().join(", ");
    let summary = match (from.is_empty(), reg.libraries.is_empty()) {
        (true, true) => trn!(
            n,
            "Libraries set up: \"{name}\" with {count} score.",
            "Libraries set up: \"{name}\" with {count} scores.",
            name = STANDARD_NAME,
            count = count
        ),
        (false, true) => trn!(
            n,
            "Libraries set up: \"{name}\" with {count} score (from {folders}).",
            "Libraries set up: \"{name}\" with {count} scores (from {folders}).",
            name = STANDARD_NAME,
            count = count,
            folders = folders
        ),
        (true, false) => trn!(
            n,
            "Libraries set up: \"{name}\" with {count} score; separate libraries: {libraries}.",
            "Libraries set up: \"{name}\" with {count} scores; separate libraries: {libraries}.",
            name = STANDARD_NAME,
            count = count,
            libraries = own
        ),
        (false, false) => trn!(
            n,
            "Libraries set up: \"{name}\" with {count} score (from {folders}); separate libraries: {libraries}.",
            "Libraries set up: \"{name}\" with {count} scores (from {folders}); separate libraries: {libraries}.",
            name = STANDARD_NAME,
            count = count,
            folders = folders,
            libraries = own
        ),
    };
    reg.libraries.insert(0, standard);
    {
        let _g = REGISTRY_LOCK.lock().map_err(|_| tr!("Library list locked"))?;
        write(root, &reg)?;
    }
    // remove old indexes (now in "Standard")
    for (_, idx, _, _) in &rest {
        let _ = std::fs::remove_file(extra_path(idx));
        let _ = std::fs::remove_file(idx);
    }
    Ok(summary)
}

// ---------------------------------------------------------------- Commands

#[tauri::command]
pub async fn library_list(app: AppHandle) -> CmdResult<Vec<LibView>> {
    Ok(list(&app))
}

#[tauri::command]
pub async fn library_create(app: AppHandle, name: String) -> CmdResult<Vec<LibView>> {
    create(&app, &name)?;
    Ok(list(&app))
}

#[tauri::command]
pub async fn library_switch(app: AppHandle, state: State<'_, AppState>, id: String) -> CmdResult<Vec<LibView>> {
    if let Some(b) = busy_text(&state) {
        return Err(b);
    }
    activate(&app, &id)?;
    let name = lock(&state.library)?.as_ref().map(|l| (l.name.clone(), l.index.score_count()));
    if let Some((name, scores)) = name {
        lock(&state.library_status)?.message =
            Some(trn!(scores, "Library \"{name}\": {count} score", "Library \"{name}\": {count} scores", name = name, count = fmt_num(scores)));
    }
    emit_info(&app);
    Ok(list(&app))
}

#[tauri::command]
pub async fn library_rename(app: AppHandle, id: String, name: String) -> CmdResult<Vec<LibView>> {
    rename(&app, &id, &name)?;
    emit_info(&app);
    Ok(list(&app))
}

#[tauri::command]
pub async fn library_delete(app: AppHandle, id: String) -> CmdResult<Vec<LibView>> {
    delete(&app, &id)?;
    emit_info(&app);
    Ok(list(&app))
}

/// Path under which a package lives (default folder in the library folder).
pub fn pack_dir(handle: &AppHandle, pack: &str) -> Option<PathBuf> {
    pack_folder(pack).map(|f| default_root(handle).join(f))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_and_alternating_files() {
        assert_eq!(slug("Standard"), "Standard");
        assert_eq!(slug("PDMX – Kostprobe"), "PDMX-Kostprobe");
        assert_eq!(slug("Übungen für Bläser!"), "Uebungen-fuer-Blaeser");
        assert_eq!(slug("  …  "), "Bibliothek");
        assert_eq!(other_file("Standard.kwix"), "Standard.neu.kwix");
        assert_eq!(other_file("Standard.neu.kwix"), "Standard.kwix");
        assert_eq!(plain_path(r"\\?\C:\Eigene\a.mxl".into()), r"C:\Eigene\a.mxl");
        assert_eq!(plain_path(r"C:\Eigene\a.mxl".into()), r"C:\Eigene\a.mxl");
        let reg = Registry { active: STANDARD.into(), libraries: vec![LibEntry { id: "test".into(), ..Default::default() }] };
        assert_eq!(unique_slug("Test", &reg, Path::new("gibt-es-nicht")), "Test-2");
        assert_eq!((fmt_de(7), fmt_de(1000), fmt_de(253_570), fmt_de(1_234_567)), ("7".into(), "1.000".into(), "253.570".into(), "1.234.567".into()));
    }
}
